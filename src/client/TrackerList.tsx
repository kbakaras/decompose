import { useEffect, useRef, useState } from 'react'
import { isTrackerSummary, TRACKER_PAGE_SIZE, trackerLabel, trackerUrl, type TrackerPage, type TrackerSummary } from '../shared/tracker'
import { cachedTrackerSearch, rememberTrackers } from './tracker-catalog'
import { appUrl } from './app-url'

export function TrackerList({ id, navigate }: { id: string; navigate: (url: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [items, setItems] = useState<TrackerSummary[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  useEffect(() => { input.current?.focus() }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    if (offset === 0) setItems([])
    const timer = window.setTimeout(async () => {
      try {
        if (!navigator.onLine) throw new Error('offline')
        const response = await fetch(appUrl(`api/tracker?q=${encodeURIComponent(query)}&offset=${offset}`), {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        })
        if (!response.ok) throw new Error('Не удалось загрузить задачи')
        const result: TrackerPage = await response.json()
        if (!Array.isArray(result.items) || !result.items.every(isTrackerSummary)
          || (result.nextOffset !== null && result.nextOffset !== offset + TRACKER_PAGE_SIZE)) throw new Error('Некорректный ответ сервера')
        if (controller.signal.aborted) return
        rememberTrackers(result.items)
        setItems(previous => [...new Map([...(offset ? previous : []), ...result.items].map(item => [item.id, item])).values()])
        setNextOffset(result.nextOffset)
        setOffline(false)
      } catch {
        if (controller.signal.aborted) return
        const cached = cachedTrackerSearch(query)
        setItems(cached.slice(0, offset + TRACKER_PAGE_SIZE))
        setNextOffset(cached.length > offset + TRACKER_PAGE_SIZE ? offset + TRACKER_PAGE_SIZE : null)
        setOffline(true)
      } finally { if (!controller.signal.aborted) setLoading(false) }
    }, query ? 250 : 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, offset])

  return <section aria-label="Деревья задач">
    <label className="tracker-search" htmlFor="tracker-search">Поиск задач
      <input ref={input} id="tracker-search" type="search" value={query} maxLength={500} placeholder="Ключ или описание"
        onChange={event => { setQuery(event.target.value); setOffset(0) }} />
    </label>
    {!query && <p>Последние изменённые деревья задач</p>}
    {offline && <p role="status">Сервер недоступен. Поиск по сохранённому неполному каталогу; offline откроются только ранее загруженные задачи.</p>}
    {loading && <p role="status">Ищем задачи…</p>}
    <nav aria-label="Список задач" className="diagrams-list">
      {items.map(item => <a key={item.id} href={trackerUrl(item.trackerKey)} aria-current={item.id === id ? 'page' : undefined}
        onClick={event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return
          event.preventDefault()
          navigate(trackerUrl(item.trackerKey))
        }}><span>{trackerLabel(item.title, item.trackerKey)}</span>{item.id === id && <small>Открыта</small>}</a>)}
    </nav>
    {!loading && !items.length && <p>Задачи не найдены.</p>}
    {nextOffset !== null && <button className="tracker-more" disabled={loading} onClick={() => setOffset(nextOffset)}>Показать ещё</button>}
  </section>
}
