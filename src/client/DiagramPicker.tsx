import { useEffect, useRef, useState } from 'react'
import { diagramUrl, isDiagramId, type DiagramSummary } from '../shared/diagrams'

const catalogKey = 'decompose:diagrams:v1'
function readCatalog(): DiagramSummary[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(catalogKey) ?? '[]')
    return Array.isArray(data) ? data.filter((item): item is DiagramSummary =>
      item && isDiagramId(item.id) && typeof item.title === 'string') : []
  } catch { return [] }
}
function saveCatalog(items: DiagramSummary[]) {
  try { localStorage.setItem(catalogKey, JSON.stringify(items)) } catch { /* Кеш списка необязателен. */ }
}

export function DiagramPicker({ id, title, connected, navigate }: {
  id: string; title: string; connected: boolean; navigate: (url: string) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<DiagramSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const cached = readCatalog()
    const existing = cached.find(item => item.id === id)
    if (existing) existing.title = title
    else cached.push({ id, title })
    saveCatalog(cached)
  }, [id, title])

  useEffect(() => {
    if (!open) return
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
  }, [open, id, title])

  return <>
    <h1 className="document-title">
      <button ref={trigger} className="diagram-trigger" aria-label="Схемы" title={`${title} — выбрать схему`}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => { dialog.current?.showModal(); setOpen(true) }}>
        <span>{title}</span><span aria-hidden="true">▾</span>
      </button>
    </h1>
    <dialog ref={dialog} className="diagrams-dialog" aria-labelledby="diagrams-heading"
      onClose={() => { setOpen(false); trigger.current?.focus() }}>
      <div className="diagrams-heading"><h2 id="diagrams-heading">Схемы</h2>
        <button className="icon-button" aria-label="Закрыть список схем" onClick={() => dialog.current?.close()}>×</button>
      </div>
      {loading && <p role="status">Загружаем список…</p>}
      {message && <p role="alert">{message}</p>}
      <nav aria-label="Список схем" className="diagrams-list">
        {items.map(item => <a key={item.id} href={diagramUrl(item.id)} aria-current={item.id === id ? 'page' : undefined}
          onClick={event => {
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
        if (creating || !name.trim()) return
        setCreating(true)
        setMessage('')
        try {
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
          placeholder="Название" maxLength={500} required disabled={creating || !connected} />
          <button type="submit" disabled={creating || !connected || !name.trim()}>{creating ? 'Создаём…' : 'Создать'}</button>
        </div>
        {!connected && <p>Для создания схемы нужно соединение с сервером.</p>}
      </form>
    </dialog>
  </>
}
