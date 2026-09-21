import { useEffect, useRef, useState } from 'react'
import { isTrackerSummary, normalizeTrackerKey, TRACKER_PAGE_SIZE, trackerLabel, trackerUrl, type TrackerPage, type TrackerSummary } from '../shared/tracker'
import { cachedTrackerSearch, rememberTrackers } from './tracker-catalog'
import { appUrl } from './app-url'
import { CatalogList, type CatalogListHandle } from './CatalogList'
import { catalogSearchKeyDown, preventRepeatedEnter } from './catalog-search'

export function TrackerList({ id, navigate }: { id?: string; navigate: (url: string) => void }) {
  const list = useRef<CatalogListHandle>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [items, setItems] = useState<TrackerSummary[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const key = normalizeTrackerKey(query)
  const [missingQuery, setMissingQuery] = useState<string | null>(null)
  const canCreate = !!key && missingQuery === query && !loading && !offline && navigator.onLine

  useEffect(() => {
    setMissingQuery(null)
    if (!key) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        if (!navigator.onLine) return
        // Совпадение ключа может находиться за пределами первой страницы поиска.
        const response = await fetch(appUrl(`api/tracker/${encodeURIComponent(key)}`), {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        })
        if (!controller.signal.aborted && (response.status === 404 || response.status === 410)) setMissingQuery(query)
      } catch { /* Ошибка проверки не означает, что ключ свободен. */ }
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [key, query])

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
    <div className="catalog-query">
      <input className="catalog-search-input" id="tracker-search" type="search" aria-label="Поиск задач"
        value={query} maxLength={500} placeholder="Ключ или описание"
        autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
        onChange={event => {
          setQuery(event.target.value); setOffset(0); setMissingQuery(null)
          setItems([]); setNextOffset(null); setLoading(true)
        }}
        onKeyDown={event => catalogSearchKeyDown(event, {
          list: list.current, createButton: createButton.current, loading,
          openFirst: items.length ? () => navigate(trackerUrl(items[0].trackerKey)) : undefined,
        })} />
      <button ref={createButton} type="button" disabled={!canCreate} onKeyDown={preventRepeatedEnter}
        onClick={() => { if (canCreate && key) navigate(trackerUrl(key)) }}>Создать</button>
    </div>
    {offline && <p role="status">Сервер недоступен. Поиск по сохранённому неполному каталогу; offline откроются только ранее загруженные задачи.</p>}
    {loading && <p role="status">Ищем задачи…</p>}
    <CatalogList ref={list} label="Список задач" currentId={id} navigate={navigate}
      items={items.map(item => ({ id: item.id, title: trackerLabel(item.title, item.trackerKey), href: trackerUrl(item.trackerKey) }))} />
    {!loading && !items.length && <p>Задачи не найдены.</p>}
    {nextOffset !== null && <button className="tracker-more" disabled={loading} onClick={() => setOffset(nextOffset)}>Показать ещё</button>}
  </section>
}
