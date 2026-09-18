import { useEffect, useRef, useState } from 'react'
import { diagramUrl, isDiagramId, type DiagramSummary } from '../shared/diagrams'
import { readYedFile } from './yed-import'
import { trackerLabel, type TrackerSummary } from '../shared/tracker'
import { readTrackerCatalog, rememberTrackers } from './tracker-catalog'
import { TrackerList } from './TrackerList'

const catalogKey = 'decompose:diagrams:v1'
function readCatalog(): DiagramSummary[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(catalogKey) ?? '[]')
    const trackerIds = new Set(readTrackerCatalog().map(item => item.id))
    return Array.isArray(data) ? data.filter((item): item is DiagramSummary =>
      item && isDiagramId(item.id) && typeof item.title === 'string' && !item.trackerKey && !trackerIds.has(item.id)) : []
  } catch { return [] }
}
function saveCatalog(items: DiagramSummary[]) {
  try { localStorage.setItem(catalogKey, JSON.stringify(items)) } catch { /* Кеш списка необязателен. */ }
}

export function DiagramPicker({ id, title, tracker, connected, navigate, requestIdentity }: {
  id: string; title: string; tracker?: TrackerSummary; connected: boolean; navigate: (url: string) => Promise<void>; requestIdentity: () => Promise<boolean>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const importingRef = useRef(false)
  const mounted = useRef(true)
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<'diagrams' | 'tracker'>(tracker ? 'tracker' : 'diagrams')
  const [items, setItems] = useState<DiagramSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  async function importFile(file: File) {
    if (importingRef.current || creating || !connected) return
    importingRef.current = true
    setImporting(true)
    setMessage('')
    try {
      const data = await readYedFile(file)
      if (!mounted.current || !await requestIdentity() || !mounted.current) return
      const response = await fetch('/api/diagrams/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        signal: AbortSignal.timeout(30000),
      }).catch(() => {
        throw new Error('Не удалось завершить импорт. Проверь соединение и список схем перед повтором: сервер мог успеть сохранить схему.')
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || !isDiagramId(result?.id) || typeof result?.title !== 'string') {
        throw new Error(result?.error || 'Не удалось импортировать схему. Проверь соединение и список схем перед повтором.')
      }
      const created: DiagramSummary = result
      const catalog = [...readCatalog(), created]
      saveCatalog(catalog)
      if (!mounted.current) return
      setItems(catalog)
      await navigate(diagramUrl(created.id))
      dialog.current?.close()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось импортировать схему.')
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }

  useEffect(() => {
    if (tracker) {
      const cached = readTrackerCatalog().find(item => item.id === id) ?? tracker
      rememberTrackers([{ ...cached, title }])
      return
    }
    const cached = readCatalog()
    const existing = cached.find(item => item.id === id)
    if (existing) existing.title = title
    else cached.push({ id, title })
    saveCatalog(cached)
  }, [id, title, tracker])

  useEffect(() => {
    if (!open || section !== 'diagrams') return
    const controller = new AbortController()
    setItems(readCatalog())
    setLoading(true)
    setMessage('')
    fetch('/api/diagrams', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Не удалось загрузить список')
        const remote: DiagramSummary[] = await response.json()
        const list = remote.map(item => item.id === id ? { id, title } : item)
        if (controller.signal.aborted) return
        setItems(list)
        saveCatalog(list)
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage('Сервер недоступен. Показан сохранённый список; offline откроются только ранее загруженные схемы.')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [open, section, id, title])

  return <>
    <h1 className="document-title">
      <button ref={trigger} className="diagram-trigger" aria-label="Схемы" title={`${trackerLabel(title, tracker?.trackerKey)} — выбрать схему`}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => { setSection(tracker ? 'tracker' : 'diagrams'); dialog.current?.showModal(); setOpen(true) }}>
        <span>{trackerLabel(title, tracker?.trackerKey)}</span><span aria-hidden="true">▾</span>
      </button>
    </h1>
    <dialog ref={dialog} className="diagrams-dialog" aria-labelledby="diagrams-heading"
      onCancel={event => { if (importing) event.preventDefault() }}
      onClose={() => { setOpen(false); trigger.current?.focus() }}>
      <div className="diagrams-heading"><h2 id="diagrams-heading">Схемы</h2>
        <button className="icon-button" aria-label="Закрыть список схем" disabled={importing} onClick={() => dialog.current?.close()}>×</button>
      </div>
      <div className="catalog-sections" role="group" aria-label="Раздел каталога">
        <button type="button" aria-pressed={section === 'diagrams'} disabled={creating || importing} onClick={() => setSection('diagrams')}>Схемы</button>
        <button type="button" aria-pressed={section === 'tracker'} disabled={creating || importing} onClick={() => setSection('tracker')}>Задачи</button>
      </div>
      {open && section === 'tracker' && <TrackerList id={id} navigate={url => {
        dialog.current?.close()
        void navigate(url).catch(error => setMessage(String(error)))
      }} />}
      {section === 'diagrams' && <>
      {loading && <p role="status">Загружаем список…</p>}
      {message && <p role="alert">{message}</p>}
      <nav aria-label="Список схем" className="diagrams-list">
        {items.map(item => <a key={item.id} href={diagramUrl(item.id)} aria-current={item.id === id ? 'page' : undefined}
          onClick={event => {
            if (importing) { event.preventDefault(); return }
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return
            event.preventDefault()
            dialog.current?.close()
            void navigate(diagramUrl(item.id)).catch(error => setMessage(String(error)))
          }}>
          <span>{item.title}</span>{item.id === id && <small>Открыта</small>}
        </a>)}
      </nav>
      <form className="diagram-create" onSubmit={async event => {
        event.preventDefault()
        if (creating || importingRef.current || !connected || !name.trim()) return
        setCreating(true)
        setMessage('')
        try {
          if (!await requestIdentity()) { setCreating(false); return }
          const response = await fetch('/api/diagrams', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: name.trim() }),
          })
          if (!response.ok) throw new Error('Не удалось создать схему. Проверь соединение и попробуй ещё раз.')
          const created: DiagramSummary = await response.json()
          saveCatalog([...readCatalog(), created])
          dialog.current?.close()
          setCreating(false)
          setName('')
          await navigate(diagramUrl(created.id))
        } catch (error) {
          setMessage(error instanceof Error ? error.message : 'Не удалось создать схему')
          setCreating(false)
        }
      }}>
        <label htmlFor="diagram-name">Новая схема</label>
        <div><input id="diagram-name" value={name} onChange={event => setName(event.target.value)}
          placeholder="Название" maxLength={500} required disabled={creating || importing || !connected} />
          <button type="submit" disabled={creating || importing || !connected || !name.trim()}>{creating ? 'Создаём…' : 'Создать'}</button>
        </div>
        {!connected && <p>Для создания схемы нужно соединение с сервером.</p>}
      </form>
      <div className="diagram-import">
        <input ref={fileInput} type="file" accept=".graphml" aria-label="Файл yEd GraphML" hidden onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void importFile(file)
        }} />
        <button type="button" disabled={creating || importing || !connected} onClick={() => fileInput.current?.click()}>
          {importing ? 'Импортируем…' : 'Импорт из yEd…'}
        </button>
        <p>GraphML: иерархия и порядок, до 1000 узлов и 5 МиБ. Откроется отдельная схема.</p>
      </div>
      </>}
    </dialog>
  </>
}
