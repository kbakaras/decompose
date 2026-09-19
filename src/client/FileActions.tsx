import { useEffect, useRef, useState } from 'react'
import type { Session } from './session'
import { canEditDiskFile, downloadDiagram, pickWritableFile, readDiagramText } from './diagram-file'
import { parseDiagramFile, type DiagramFile } from '../shared/diagram-file'
import { diagramUrl } from '../shared/diagrams'
import { appUrl } from './app-url'
import type { OpenLocalFile } from './file-session'

export function FileActions({ open, close, returnFocus, session, title, navigate, openLocal, requestIdentity }: {
  open: boolean; close: () => void; returnFocus: () => void; session: Session; title: string
  navigate: (href: string) => Promise<void>; openLocal: OpenLocalFile
  requestIdentity: () => Promise<boolean>
}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState('new'), [file, setFile] = useState<DiagramFile | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { if (open) { setError(''); setFile(null); dialog.current?.showModal() } else dialog.current?.close() }, [open])
  async function importFile(value: DiagramFile) {
    setBusy(true); setError('')
    try {
      dialog.current?.close()
      const accepted = await requestIdentity()
      dialog.current?.showModal()
      if (!accepted) return
      const response = await fetch(appUrl(mode === 'replace' ? `api/diagrams/${session.id}/replace` : 'api/diagrams/import'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'replace' ? { generation: session.generation, file: value } : value),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось загрузить файл.')
      close(); if (mode === 'new') await navigate(diagramUrl(result.id))
    } catch (error) { setError(error instanceof Error ? error.message : 'Ошибка загрузки.') }
    finally { setBusy(false) }
  }
  return <dialog ref={dialog} className="diagrams-dialog file-dialog" aria-label="Открыть файл схемы"
    onClose={returnFocus}
    onCancel={event => { if (busy) event.preventDefault(); else close() }}>
    <h2>Открыть файл схемы</h2>
    {file && mode === 'replace' ? <>
      <p>Заменить «{title}» содержимым файла? Подключённые вкладки будут заблокированы до синхронизации. История undo будет сброшена; старые offline-правки не объединятся с новым деревом.</p>
      <button disabled={busy} onClick={() => { try { downloadDiagram(session.doc, title) } catch (error) { setError(String(error)) } }}>Скачать прежнюю схему</button>{' '}
      <button disabled={busy} onClick={() => { void importFile(file) }}>{busy ? 'Ожидаем синхронизацию…' : 'Заменить схему'}</button>
    </> : <>
      <fieldset disabled={busy}>
        <legend>Способ открытия</legend>
        <label><input type="radio" name="file-mode" value="new" checked={mode === 'new'} onChange={() => setMode('new')} />Создать новую схему в системе</label>
        <label><input type="radio" name="file-mode" value="replace" checked={mode === 'replace'} disabled={session.source !== 'system' || !session.canEdit} onChange={() => setMode('replace')} />Заменить открытую схему</label>
        <label><input type="radio" name="file-mode" value="disk" checked={mode === 'disk'} onChange={() => setMode('disk')} />Редактировать файл на диске</label>
      </fieldset>
      <p>{mode === 'disk' ? 'Единственное постоянное хранилище — выбранный файл. Изменения сохраняются автоматически.' : 'Файл не изменится. Схема будет храниться на сервере.'}</p>
      {mode === 'disk' && !canEditDiskFile() && <p>Для записи в исходный файл нужны HTTPS или локальный запуск и поддерживаемый браузер, например Chrome/Edge.</p>}
      <input ref={input} type="file" accept=".json" aria-label="Файл дерево·дел" hidden onChange={event => {
        const selected = event.currentTarget.files?.[0]; event.currentTarget.value = ''
        if (!selected) return
        setError('')
        void readDiagramText(selected).then(text => {
          const value = parseDiagramFile(text)
          if (mode === 'replace') setFile(value); else return importFile(value)
        }).catch(error => setError(String(error)))
      }} />
      <button disabled={busy || (mode !== 'disk' && !navigator.onLine) || (mode === 'replace' && !session.connected) || (mode === 'disk' && !canEditDiskFile())}
        onClick={() => {
          if (mode !== 'disk') { input.current?.click(); return }
          void pickWritableFile().then(async ({ handle, text }) => { await openLocal(handle, text); close() }).catch(error => {
            if (!(error instanceof DOMException && error.name === 'AbortError')) setError(String(error))
          })
        }}>{busy ? 'Загружаем…' : 'Выбрать файл…'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={close}>Отмена</button>
  </dialog>
}
