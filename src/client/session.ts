import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { getStructures, ROOT_ID } from '../domain'
import { isDiagramId } from '../shared/diagrams'
import { documentName } from '../shared/document-generation'
import { flushPersistence, protectPendingUpdates } from './local-persistence'
import { browserIdentity } from './identity'
import { isTrackerSummary, type TrackerSummary } from '../shared/tracker'
import { readTrackerCatalog, rememberTrackers } from './tracker-catalog'
import { collaborationUrl } from './collaboration-url'
import { appBaseUrl, appUrl } from './app-url'
import { Session } from './session-base'
import { clearDeletedContent, DiagramDeleted, knownDeletion, rememberDeletion, subscribeDeletion, type DeletedDiagram } from './deleted-diagrams'
export { Session }
export type { Participant } from './presence'

function cachedGeneration(id: string) {
  try { const value = Number(localStorage.getItem(`decompose:generation:${id}`) ?? 0); return Number.isSafeInteger(value) && value >= 0 ? value : 0 } catch { return 0 }
}
async function serverGeneration(id: string, signal?: AbortSignal) {
  const response = await fetch(appUrl(`api/diagrams/${id}/generation`), { cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) })
  if (response.status === 410) throw new DiagramDeleted(await response.json())
  if (!response.ok) throw new Error(response.status === 404 ? 'Схема не найдена' : 'Сервер не смог открыть схему')
  const { generation } = await response.json()
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Некорректное поколение схемы')
  return generation as number
}

export async function openSession(id = 'main', signal?: AbortSignal, tracker?: TrackerSummary, acceptLatest = false): Promise<Session> {
  if (!isDiagramId(id)) throw new Error('Некорректная ссылка на схему')
  browserIdentity(); tracker ??= readTrackerCatalog().find(item => item.id === id)
  const cached = cachedGeneration(id)
  let latest = cached
  let deletion = knownDeletion(id)
  try { latest = await serverGeneration(id, signal) }
  catch (error) {
    if (error instanceof DiagramDeleted) deletion = error.deletion
    else if (signal?.aborted || !(error instanceof TypeError || error instanceof DOMException)) throw error
  }
  const generation = acceptLatest ? latest : cached, name = documentName(id, generation)
  const doc = new Y.Doc(), persistence = new IndexeddbPersistence(`decompose:${name}:v1`, doc)
  await persistence.whenSynced
  if (!acceptLatest && latest !== cached && !getStructures(doc).nodes.has(ROOT_ID)) {
    await persistence.destroy(); doc.destroy(); return openSession(id, signal, tracker, true)
  }
  let unprotect: (() => void) | undefined, session: Session | undefined
  try {
    signal?.throwIfAborted(); unprotect = await protectPendingUpdates(name, doc, persistence)
    if (deletion && !getStructures(doc).nodes.has(ROOT_ID)) {
      rememberDeletion(deletion); await persistence.destroy(); await clearDeletedContent(deletion)
      throw new DiagramDeleted(deletion)
    }
    if (!deletion && id !== 'main' && !getStructures(doc).nodes.has(ROOT_ID)) {
      const response = await fetch(appUrl(`api/diagrams/${id}`), { cache: 'no-store', signal })
      if (!response.ok) throw new Error(response.status === 404 ? 'Схема не найдена' : 'Сервер не смог открыть схему')
      const summary: unknown = await response.json()
      if (isTrackerSummary(summary)) { tracker = summary; rememberTrackers([summary]) }
    }
    signal?.throwIfAborted()
    session = new Session(id, doc, 'system', tracker); session.generation = generation
    session.persist = () => flushPersistence(persistence)
    let retirement: Promise<void> | undefined
    let unsubscribeDeleted = () => {}
    session.release = async () => { unsubscribeDeleted(); unprotect?.(); await (retirement ?? persistence.destroy()) }
    try { localStorage.setItem(`decompose:generation:${id}`, String(generation)) } catch { /* Метаданные кеша необязательны. */ }
    const current = session
    current.retire = (value: DeletedDiagram) => {
      if (current.deleted) return retirement ?? Promise.resolve()
      current.prepare?.(); current.deleted = true; current.blocked = true
      current.message = 'Схема удалена из системы. Снимок и несохранённые правки доступны только в этой вкладке: скачай копию перед уходом.'
      current.provider?.disconnect(); unprotect?.(); unprotect = undefined
      current.persist = async () => {}
      rememberDeletion(value)
      retirement = persistence.destroy().then(() => clearDeletedContent(value)).catch(error => {
        current.message += ' Не удалось полностью очистить локальный кеш.'; console.error(error)
      })
      current.emit(); return retirement
    }
    unsubscribeDeleted = subscribeDeletion(id, value => { void current.retire!(value) })
    if (deletion) { await current.retire(deletion); return current }
    const markOutdated = () => {
      current.prepare?.(); current.outdated = true; current.blocked = true
      current.message = 'Схема заменена. Старые изменения не отправлены. Скачай копию перед открытием актуальной схемы.'
      current.provider?.disconnect(); current.emit()
    }
    if (latest !== generation) { markOutdated(); return current }
    const provider = new HocuspocusProvider({
      url: collaborationUrl(appBaseUrl), name, document: doc,
      onAuthenticationFailed: () => {
        void serverGeneration(id).then(value => {
          if (value !== generation) markOutdated()
          else { current.message = 'Схема временно заблокирована. Повтори открытие после завершения замены.'; current.emit() }
        }).catch(error => { if (error instanceof DiagramDeleted) void current.retire!(error.deletion) })
      },
      onStateless: ({ payload }) => {
        let message
        try { message = JSON.parse(payload) } catch { return }
        if (message.type === 'replace-prepare') {
          current.prepare?.(); current.blocked = true; current.message = 'Операция со схемой: ожидаем синхронизацию вкладок…'; current.emit()
          void current.synced().then(() => { if (current.blocked && !current.outdated) provider.sendStateless(JSON.stringify({ type: 'replace-ready', operation: message.operation })) }).catch(() => {})
        } else if (message.type === 'replace-cancelled' && !current.deleted) { current.blocked = false; current.message = ''; current.emit() }
        else if (message.type === 'replaced') { current.reloadRequested = true; current.emit() }
        else if (message.type === 'deleted') void current.retire!(message)
      },
    })
    current.attach(provider); return current
  } catch (error) {
    if (session) await session.destroy(); else { unprotect?.(); await persistence.destroy(); doc.destroy() }
    throw error
  }
}
