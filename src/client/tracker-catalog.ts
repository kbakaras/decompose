import { isTrackerSummary, trackerSearch, type TrackerSummary } from '../shared/tracker'
import { appUrl } from './app-url'
import { clearDeletedContent, knownDeletion, rememberDeletion } from './deleted-diagrams'

const catalogKey = 'decompose:tracker:v1'
const memory = new Map<string, TrackerSummary>()

export function readTrackerCatalog(): TrackerSummary[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(catalogKey) ?? '[]')
    if (Array.isArray(saved)) for (const item of saved) if (isTrackerSummary(item)) memory.set(item.trackerKey, item)
  } catch { /* Необязательный кеш может быть недоступен. */ }
  for (const [key, item] of memory) if (knownDeletion(item.id)) memory.delete(key)
  return [...memory.values()]
}

export function rememberTrackers(items: TrackerSummary[]) {
  readTrackerCatalog()
  for (const item of items) if (!knownDeletion(item.id)) memory.set(item.trackerKey, item)
  try { localStorage.setItem(catalogKey, JSON.stringify([...memory.values()])) }
  catch { /* В этой вкладке остаётся кеш в памяти. */ }
}

export function cachedTrackerSearch(query: string): TrackerSummary[] {
  const search = trackerSearch(query)
  return readTrackerCatalog().filter(item => trackerSearch(item.trackerKey).includes(search) || trackerSearch(item.title).includes(search))
    .sort((left, right) => right.updatedAt - left.updatedAt || (left.trackerKey < right.trackerKey ? -1 : left.trackerKey > right.trackerKey ? 1 : 0))
}

export class TrackerCreationCancelled extends Error {}
export class TrackerDeleted extends Error {
  constructor(readonly id: string) { super('Дерево задачи удалено.') }
}

export async function resolveTracker(key: string, signal: AbortSignal, requestIdentity: () => Promise<boolean>, recreateDeletedId?: string): Promise<TrackerSummary> {
  const cached = readTrackerCatalog().find(item => item.trackerKey === key)
  const offline = () => {
    if (cached) return cached
    throw new Error('Для первого открытия этой задачи нужно соединение с сервером')
  }
  if (!navigator.onLine) return offline()
  let response: Response
  try {
    response = await fetch(appUrl(`api/tracker/${encodeURIComponent(key)}`), {
      cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    })
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) return offline()
    throw error
  }
  signal.throwIfAborted()
  if (response.status === 410) {
    const deleted = await response.json()
    rememberDeletion(deleted); void clearDeletedContent(deleted).catch(console.error)
    if (recreateDeletedId !== deleted.id) throw new TrackerDeleted(deleted.id)
  }
  if (response.status === 404 || response.status === 410) {
    if (!await requestIdentity()) throw new TrackerCreationCancelled()
    signal.throwIfAborted()
    response = await fetch(appUrl(`api/tracker/${encodeURIComponent(key)}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recreateDeletedId }), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    }).catch(() => {
      throw new Error('Не удалось завершить создание. Повтори открытие ссылки: если схема уже сохранена, откроется она же.')
    })
  }
  if (!response.ok) throw new Error('Сервер не смог открыть дерево задачи')
  const item: unknown = await response.json()
  if (!isTrackerSummary(item) || item.trackerKey !== key) throw new Error('Некорректный ответ сервера')
  rememberTrackers([item])
  return item
}
