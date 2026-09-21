import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { diagramUrl, isDiagramId, type DiagramSummary } from '../shared/diagrams'
import type { FileAction } from './FileActions'
import { trackerLabel, type TrackerSummary } from '../shared/tracker'
import { readTrackerCatalog, rememberTrackers } from './tracker-catalog'
import { TrackerList } from './TrackerList'
import { CatalogList, type CatalogListHandle } from './CatalogList'
import { catalogSearchKeyDown, preventRepeatedEnter } from './catalog-search'
import { appUrl } from './app-url'
import { knownDeletion } from './deleted-diagrams'

const catalogKey = 'decompose:diagrams:v1'
type CatalogSection = 'diagrams' | 'tracker' | 'files'
const catalogSections: { id: CatalogSection; label: string }[] = [
  { id: 'diagrams', label: 'Схемы' }, { id: 'tracker', label: 'Задачи' }, { id: 'files', label: 'Файлы' },
]
function readCatalog(): DiagramSummary[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(catalogKey) ?? '[]')
    const trackerIds = new Set(readTrackerCatalog().map(item => item.id))
    return Array.isArray(data) ? data.filter((item): item is DiagramSummary =>
      item && isDiagramId(item.id) && !knownDeletion(item.id) && typeof item.title === 'string' && !item.trackerKey && !trackerIds.has(item.id)) : []
  } catch { return [] }
}
function saveCatalog(items: DiagramSummary[]) {
  try { localStorage.setItem(catalogKey, JSON.stringify(items)) } catch { /* Кеш списка необязателен. */ }
}

export function DiagramPicker({ id, title = '', tracker, connected, navigate, requestIdentity, temporary = false, actions, openFile, prepare, returnFocus, triggerContent, modeLabel, currentName, currentSection = 'diagrams', renderTrigger }: {
  id?: string; title?: string; tracker?: TrackerSummary; connected: boolean; navigate: (url: string) => Promise<void>; requestIdentity: () => Promise<boolean>; temporary?: boolean
  actions?: (close: () => void) => ReactNode; openFile: (mode: FileAction | 'disk') => void; prepare?: () => void; returnFocus: () => void; triggerContent?: ReactNode
  modeLabel?: string; currentName?: string; currentSection?: CatalogSection
  renderTrigger?: (open: () => void, expanded: boolean) => ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const diagramList = useRef<CatalogListHandle>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState(currentSection)
  const [focusedSection, setFocusedSection] = useState(currentSection)
  const tabs = useRef<Partial<Record<CatalogSection, HTMLButtonElement>>>({})
  const [items, setItems] = useState<DiagramSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const matchingItems = items.filter(item => item.title.toLowerCase().includes(name.trim().toLowerCase()))
  const [message, setMessage] = useState('')
  const movingFocus = useRef(false)
  const closeForAction = () => { movingFocus.current = true; dialog.current?.close() }
  const openPicker = useCallback(() => {
    prepare?.()
    setSection(currentSection)
    setFocusedSection(currentSection)
    setName('')
    dialog.current?.showModal()
    setOpen(true)
    tabs.current[currentSection]?.focus({ preventScroll: true })
  }, [prepare, currentSection])
  useEffect(() => {
    const openFromKeyboard = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.code !== 'KeyO'
        || event.altKey || event.shiftKey || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat || document.querySelector('dialog[open]')) return
      openPicker()
    }
    window.addEventListener('keydown', openFromKeyboard, true)
    return () => window.removeEventListener('keydown', openFromKeyboard, true)
  }, [openPicker])
  useEffect(() => {
    const url = new URL(location.href)
    if (url.searchParams.get('choose') !== '1') return
    url.searchParams.delete('choose'); history.replaceState(null, '', url)
    openPicker()
  }, [])

  // Измеряем естественную высоту содержимого, чтобы окно росло вниз без скачка центра.
  useLayoutEffect(() => {
    const element = dialog.current, body = content.current
    if (!open || !element || !body) return
    const resize = () => {
      const style = getComputedStyle(element)
      const frame = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
      element.style.height = `${Math.ceil(body.getBoundingClientRect().height + frame)}px`
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(body)
    return () => { observer.disconnect(); element.style.removeProperty('height') }
  }, [open])

  useEffect(() => {
    if (!id || temporary || knownDeletion(id)) return
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
  }, [id, title, tracker, temporary])

  useEffect(() => {
    if (!open || section !== 'diagrams') return
    const controller = new AbortController()
    setItems(readCatalog())
    setLoading(true)
    setMessage('')
    fetch(appUrl('api/diagrams'), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Не удалось загрузить список')
        const remote: DiagramSummary[] = await response.json()
        const list = remote.filter(item => !knownDeletion(item.id)).map(item => item.id === id ? { id, title } : item)
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

  const openDiagram = (url: string) => {
    dialog.current?.close()
    void navigate(url).catch(error => setMessage(String(error)))
  }
  const createDiagram = async () => {
    if (creating || !connected || !name.trim()) return
    setCreating(true)
    setMessage('')
    try {
      if (!await requestIdentity()) { setCreating(false); return }
      const response = await fetch(appUrl('api/diagrams'), {
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
  }

  return <>
    {renderTrigger ? renderTrigger(openPicker, open) : <h1 className={`document-title${triggerContent ? ' document-title-file' : ''}`}>
      <button className={`diagram-trigger${triggerContent ? ' file-trigger' : ''}`} aria-label="Схемы" title={triggerContent ? undefined : `${trackerLabel(title, tracker?.trackerKey)} — выбрать схему`}
        aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="Control+O Meta+O" onClick={openPicker}>
        {triggerContent ?? <><span>{trackerLabel(title, tracker?.trackerKey)}</span><span aria-hidden="true">▾</span></>}
      </button>
    </h1>}
    <dialog ref={dialog} className="diagrams-dialog management-dialog" aria-labelledby="diagrams-heading"
      onCancel={event => { if (creating) event.preventDefault() }}
      onClose={() => { setOpen(false); if (!movingFocus.current) returnFocus(); movingFocus.current = false }}>
      <div ref={content} className="management-content">
      <div className="diagrams-heading"><h2 id="diagrams-heading">Выбор схемы для редактирования</h2>
        <button className="icon-button" aria-label="Закрыть список схем" disabled={creating} onClick={() => dialog.current?.close()}>×</button>
      </div>
      {id && <section className="current-scheme" aria-label="Текущая схема">
        <div className="current-scheme-heading">
          <span className="storage-kind">{modeLabel}</span>
          <p className="current-scheme-name">{currentName}</p>
        </div>
        <fieldset className="scheme-actions" disabled={creating}>{actions?.(closeForAction)}</fieldset>
      </section>}
      <section className="open-scheme" aria-label="Открыть другую">
      <div className="catalog-sections" role="tablist" aria-label="Раздел каталога">
        {catalogSections.map((item, index) => <button key={item.id} ref={element => { tabs.current[item.id] = element ?? undefined }}
          id={`catalog-tab-${item.id}`} type="button" role="tab" aria-selected={section === item.id}
          aria-controls={`catalog-panel-${item.id}`} tabIndex={focusedSection === item.id ? 0 : -1} disabled={creating}
          onFocus={() => setFocusedSection(item.id)} onClick={() => setSection(item.id)} onKeyDown={event => {
            let next: number
            if (event.key === 'ArrowRight') next = (index + 1) % catalogSections.length
            else if (event.key === 'ArrowLeft') next = (index + catalogSections.length - 1) % catalogSections.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = catalogSections.length - 1
            else return
            event.preventDefault()
            event.stopPropagation()
            tabs.current[catalogSections[next].id]?.focus()
          }}>{item.label}</button>)}
      </div>
      <div id="catalog-panel-tracker" role="tabpanel" aria-labelledby="catalog-tab-tracker" hidden={section !== 'tracker'}>
      {open && section === 'tracker' && <TrackerList id={id} navigate={url => {
        dialog.current?.close()
        void navigate(url).catch(error => setMessage(String(error)))
      }} />}
      </div>
      <div id="catalog-panel-diagrams" role="tabpanel" aria-labelledby="catalog-tab-diagrams" hidden={section !== 'diagrams'}>
      {section === 'diagrams' && <>
      <form className="diagram-create" autoComplete="off" noValidate onSubmit={event => event.preventDefault()}>
        <div className="catalog-query"><input className="catalog-search-input" id="diagram-name" type="search" aria-label="Поиск или название новой схемы" value={name} onChange={event => setName(event.target.value)}
          autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
          onKeyDown={event => catalogSearchKeyDown(event, {
            list: diagramList.current, createButton: createButton.current, loading,
            openFirst: matchingItems.length ? () => openDiagram(diagramUrl(matchingItems[0].id)) : undefined,
          })}
          placeholder="Название схемы" maxLength={500} disabled={creating} />
          <button ref={createButton} type="button" disabled={creating || !connected || !name.trim()}
            onKeyDown={preventRepeatedEnter}
            onClick={() => { void createDiagram() }}>{creating ? 'Создаём' : 'Создать'}</button>
        </div>
        {!connected && <p>Для создания схемы нужно соединение с сервером.</p>}
      </form>
      {message && <p role="alert">{message}</p>}
      {loading && <p role="status">Загружаем список…</p>}
      <CatalogList ref={diagramList} label="Список схем" currentId={id} disabled={creating}
        items={matchingItems.map(item => ({ ...item, href: diagramUrl(item.id) }))} navigate={openDiagram} />
      {!loading && !matchingItems.length && <p role="status">{name.trim() ? 'Схемы не найдены.' : 'Сохранённых схем нет.'}</p>}
      </>}
      </div>
      <div id="catalog-panel-files" role="tabpanel" aria-labelledby="catalog-tab-files" hidden={section !== 'files'}>
      {section === 'files' && <div className="file-choices">
        <button type="button" aria-label="Открыть файл на диске" onClick={() => { closeForAction(); openFile('disk') }}>Открыть файл на диске<small>DECO · автосохранение в исходный файл</small></button>
        <button type="button" aria-label="Новая схема из файла" disabled={!connected} onClick={() => { closeForAction(); openFile('new') }}>Новая схема из файла<small>DECO или GraphML · копия во внутреннем хранилище</small></button>
        {!connected && <p>Для создания внутренней схемы нужно соединение с сервером.</p>}
      </div>}
      </div>
      </section>
      </div>
    </dialog>
  </>
}
