import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { DocumentHistory, getStructures, ROOT_ID, SCHEMA_VERSION, TreeCommands } from '../domain'
import { isDiagramId } from '../shared/diagrams'
import { flushPersistence, protectPendingUpdates } from './local-persistence'
import { browserIdentity } from './identity'

export interface Participant {
  clientId: number
  userId: string
  name: string
  color: string
  activeNode: string | null
  editingNode: string | null
}

export async function openSession(id = 'main', signal?: AbortSignal) {
  if (!isDiagramId(id)) throw new Error('Некорректная ссылка на схему')
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(`decompose:${id}:v1`, doc)
  await persistence.whenSynced
  let unprotect: () => void
  try {
    signal?.throwIfAborted()
    unprotect = await protectPendingUpdates(id, doc, persistence)
  }
  catch (error) {
    await persistence.destroy()
    doc.destroy()
    throw error
  }
  try {
    signal?.throwIfAborted()
    if (id !== 'main' && !getStructures(doc).nodes.has(ROOT_ID)) {
      const response = await fetch(`/api/diagrams/${id}`, { cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]) })
      if (response.status === 404) throw new Error('Схема не найдена')
      if (!response.ok) throw new Error('Сервер не смог открыть схему')
    }
    signal?.throwIfAborted()
  } catch (error) {
    unprotect()
    await persistence.destroy()
    doc.destroy()
    if (signal?.aborted) throw error
    if (error instanceof TypeError || !navigator.onLine || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new Error('Для первого открытия этой схемы нужно соединение с сервером')
    }
    throw error
  }
  const history = new DocumentHistory(doc)
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const provider = new HocuspocusProvider({
    url: `${protocol}//${location.host}/collaboration`,
    name: id,
    document: doc,
  })
  const identity = browserIdentity()
  provider.setAwarenessField('user', identity)
  let closed = false
  const offline = () => provider.disconnect()
  const online = () => { if (!closed) void provider.connect() }
  let hiddenState: Record<string, unknown> | null = null
  const pagehide = () => {
    hiddenState = provider.awareness?.getLocalState() ?? null
    provider.awareness?.setLocalState(null)
    provider.disconnect()
  }
  const pageshow = (event: PageTransitionEvent) => {
    if (event.persisted && !closed) {
      provider.awareness?.setLocalState(hiddenState ?? { user: identity })
      if (navigator.onLine) online()
    }
  }
  window.addEventListener('pagehide', pagehide, true)
  window.addEventListener('pageshow', pageshow)
  window.addEventListener('offline', offline)
  window.addEventListener('online', online)
  if (!navigator.onLine) offline()

  const flush = () => flushPersistence(persistence)
  const ready = () => {
    const { meta, nodes } = getStructures(doc)
    return meta.get('schemaVersion') === SCHEMA_VERSION && nodes.has(ROOT_ID)
  }
  let closing: Promise<void> | undefined

  return {
    id, doc, provider, persistence, identity, history, flush,
    commands: new TreeCommands(doc),
    ready,
    async whenReady(signal: AbortSignal) {
      signal.throwIfAborted()
      if (ready()) return
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer)
          doc.off('update', changed)
          provider.off('authenticationFailed', denied)
          signal.removeEventListener('abort', aborted)
          if (error) reject(error); else resolve()
        }
        const changed = () => { if (ready()) finish() }
        const denied = () => finish(new Error('Сервер отклонил открытие схемы'))
        const aborted = () => finish(new DOMException('Переход отменён', 'AbortError'))
        const timer = setTimeout(() => finish(new Error('Не удалось загрузить схему. Проверь соединение с сервером.')), 10000)
        doc.on('update', changed)
        provider.on('authenticationFailed', denied)
        signal.addEventListener('abort', aborted, { once: true })
        changed()
      })
    },
    participants(): Participant[] {
      if (!navigator.onLine || provider.configuration.websocketProvider.status !== 'connected') return []
      return [...(provider.awareness?.getStates().entries() ?? [])]
        .filter(([, state]) => typeof state.user?.name === 'string')
        .map(([clientId, state]) => ({
          clientId,
          userId: typeof state.user?.id === 'string' ? state.user.id : `legacy:${clientId}`,
          name: state.user.name,
          color: typeof state.user?.color === 'string' ? state.user.color : '#777',
          activeNode: typeof state.activeNode === 'string' ? state.activeNode : null,
          editingNode: typeof state.editingNode === 'string' ? state.editingNode : null,
        }))
    },
    destroy() {
      if (closing) return closing
      closed = true
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
      window.removeEventListener('pagehide', pagehide, true)
      window.removeEventListener('pageshow', pageshow)
      // Снимаем presence и закрываем сокет до ожидания IndexedDB.
      provider.destroy()
      closing = (async () => {
        try { await flush() }
        finally {
          unprotect()
          history.destroy()
          await persistence.destroy()
          doc.destroy()
        }
      })()
      return closing
    },
  }
}

export type Session = Awaited<ReturnType<typeof openSession>>
