import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { Session } from './session'
import { downloadDiagram, readDiagramText } from './diagram-file'
import { parseDiagramFile, type DiagramFile } from '../shared/diagram-file'
import { diagramUrl, isDiagramId } from '../shared/diagrams'
import { appUrl } from './app-url'
import { readYedFile } from './yed-import'

export type FileAction = 'new' | 'replace'
export interface FileActionsHandle { open(mode: FileAction): void }

export function FileActions({ ref, returnFocus, reportError, session, title = '', navigate, requestIdentity }: {
  ref: Ref<FileActionsHandle>; returnFocus: () => void; reportError: (message: string | null) => void
  session?: Session; title?: string; navigate: (href: string) => Promise<void>
  requestIdentity: () => Promise<boolean>
}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null)
  const mode = useRef<FileAction>('new')
  const [file, setFile] = useState<DiagramFile | null>(null), [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [showProgress, setShowProgress] = useState(false)
  const lifetime = useRef<AbortController | null>(null), running = useRef(false)
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const element = input.current
    element?.addEventListener('cancel', returnFocus)
    return () => element?.removeEventListener('cancel', returnFocus)
  }, [returnFocus])
  useEffect(() => {
    if (!busy) { setShowProgress(false); return }
    const timer = setTimeout(() => setShowProgress(true), 400)
    return () => clearTimeout(timer)
  }, [busy])
  useImperativeHandle(ref, () => ({ open(action) {
    if (running.current || !navigator.onLine || action === 'replace' && !session?.connected) { returnFocus(); return }
    mode.current = action; setFile(null); setError(''); reportError(null)
    // Системный выбор запускается из исходного click, а не из эффекта React.
    input.current?.click()
  } }))
  useEffect(() => { if (file) dialog.current?.showModal(); else dialog.current?.close() }, [file])
  async function selectFile(selected: File) {
    if (running.current) return
    running.current = true; setBusy(true); reportError(null)
    const action = mode.current
    try {
      const value: DiagramFile = /\.graphml$/i.test(selected.name)
        ? { format: 'decompose', version: 1, ...await readYedFile(selected), settings: { textAlign: action === 'new' ? 'center' : 'left' } }
        : parseDiagramFile(await readDiagramText(selected))
      lifetime.current?.signal.throwIfAborted()
      if (action === 'replace') { setFile(value); setFileName(selected.name) } else await importFile(value, action)
    } catch (error) {
      if (!lifetime.current?.signal.aborted) reportError(error instanceof Error ? error.message : 'Ошибка загрузки.')
    } finally { running.current = false; setBusy(false); returnFocus() }
  }
  async function importFile(value: DiagramFile, action: FileAction) {
    if (action === 'replace' && !session) return
    running.current = true; setBusy(true); setError('')
    try {
      dialog.current?.close()
      const accepted = await requestIdentity()
      lifetime.current?.signal.throwIfAborted()
      if (action === 'replace') dialog.current?.showModal()
      if (!accepted) return
      const response = await fetch(appUrl(action === 'replace' ? 'api/diagrams/' + session!.id + '/replace' : 'api/diagrams/import'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'replace' ? { generation: session!.generation, file: value } : value),
        signal: AbortSignal.any([AbortSignal.timeout(30000), ...(lifetime.current ? [lifetime.current.signal] : [])]),
      })
      const result = await response.json()
      lifetime.current?.signal.throwIfAborted()
      if (!response.ok) throw new Error(result.error || 'Не удалось загрузить файл.')
      if (action === 'new' && !isDiagramId(result.id)) throw new Error('Сервер не вернул адрес схемы. Проверь каталог перед повтором.')
      setFile(null)
      if (action === 'new') await navigate(diagramUrl(result.id))
    } catch (error) {
      if (lifetime.current?.signal.aborted) return
      const message = error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError'
        ? 'Не удалось получить ответ сервера. Проверь каталог или текущую схему перед повтором.'
        : error instanceof Error ? error.message : 'Ошибка загрузки.'
      if (action === 'replace') setError(message); else reportError(message)
    } finally { running.current = false; setBusy(false); returnFocus() }
  }
  return <>
    <input ref={input} type="file" accept=".deco,.json,.graphml" aria-label="Файл схемы" hidden
      onChange={event => {
        const selected = event.currentTarget.files?.[0]; event.currentTarget.value = ''
        if (selected) void selectFile(selected); else returnFocus()
      }} />
    {showProgress && busy && !file && <div className="navigation-notice" role="status">Загружаем файл…</div>}
    {session && <dialog ref={dialog} className="diagrams-dialog file-dialog confirmation-dialog" aria-labelledby="replace-heading"
      onClose={returnFocus} onCancel={event => { if (busy) event.preventDefault(); else setFile(null) }}>
      <h2 id="replace-heading">Заменить содержимое схемы</h2>
      <p>Заменить «{title}» содержимым «{fileName}»? Адрес и привязка к задаче сохранятся.</p>
      <p>На время синхронизации редактирование в подключённых вкладках будет заблокировано. История отмены будет сброшена. Несинхронизированные изменения, сделанные без подключения к серверу, не будут объединены с новым деревом.</p>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => { try { downloadDiagram(session.doc, title) } catch (error) { setError(String(error)) } }}>Скачать прежнюю схему</button>
        <button className="danger-button" disabled={busy || !file} onClick={() => { if (file && !running.current) void importFile(file, 'replace') }}>{busy ? 'Ожидаем синхронизацию' : 'Заменить схему'}</button>
        <button disabled={busy} onClick={() => setFile(null)}>Отмена</button>
      </div>
    </dialog>}
  </>
}
