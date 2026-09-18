import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { DocumentHistory, getStructures, ROOT_ID, SCHEMA_VERSION, TreeCommands } from '../domain'
import { isDiagramId } from '../shared/diagrams'
import { flushPersistence, protectPendingUpdates } from './local-persistence'
import { browserIdentity, refreshIdentity, subscribeIdentity } from './identity'
import { readParticipants, type Participant } from './presence'
import { isTrackerSummary, type TrackerSummary } from '../shared/tracker'
import { readTrackerCatalog, rememberTrackers } from './tracker-catalog'
import { collaborationUrl } from './collaboration-url'
import { appBaseUrl, appUrl } from './app-url'
export type { Participant } from './presence'

export async function openSession(id = 'main', signal?: AbortSignal, tracker?: TrackerSummary) {
  if (!isDiagramId(id)) throw new Error('Некорректная ссылка на схему')
  // Ошибка создания профиля не должна оставлять открытые ресурсы сессии.
  browserIdentity()
  tracker ??= readTrackerCatalog().find(item => item.id === id)
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
      const response = await fetch(appUrl(`api/diagrams/${id}`), { cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]) })
      if (response.status === 404) throw new Error('Схема не найдена')
      if (!response.ok) throw new Error('Сервер не смог открыть схему')
      const summary: unknown = await response.json()
      if (isTrackerSummary(summary)) { tracker = summary; rememberTrackers([summary]) }
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
  const provider = new HocuspocusProvider({
    url: collaborationUrl(appBaseUrl),
    name: id,
    document: doc,
  })
  let closed = false
  let hidden = false
  const selection: { activeNode: string | null; editingNode: string | null } = { activeNode: null, editingNode: null }
  const publishIdentity = () => {
    if (closed || hidden) return
    const identity = browserIdentity()
    provider.awareness?.setLocalState({
      user: identity,
      activeNode: identity.name ? selection.activeNode : null,
      editingNode: identity.name ? selection.editingNode : null,
    })
  }
  publishIdentity()
  const unsubscribeIdentity = subscribeIdentity(publishIdentity)
  const offline = () => provider.disconnect()
  const online = () => { if (!closed && !hidden) void provider.connect() }
  const pagehide = () => {
    hidden = true
    provider.awareness?.setLocalState(null)
    provider.disconnect()
  }
  const pageshow = (event: PageTransitionEvent) => {
    if (event.persisted && !closed) {
      refreshIdentity()
      hidden = false
      publishIdentity()
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
    id, tracker, doc, provider, persistence, history, flush,
    get identity() { return browserIdentity() },
    setPresence(field: 'activeNode' | 'editingNode', value: string | null) {
      selection[field] = value
      publishIdentity()
    },
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
      return readParticipants(provider.awareness?.getStates().entries() ?? [])
    },
    destroy() {
      if (closing) return closing
      closed = true
      unsubscribeIdentity()
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
