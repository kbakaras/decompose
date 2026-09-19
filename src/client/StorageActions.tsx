import { useEffect, useRef, useState } from 'react'
import type { Session } from './session'
import { appUrl } from './app-url'
import { createUuid } from '../shared/uuid'
import { canSaveDiskFile, downloadDiagram, pickSaveFile, writeDiagramFile } from './diagram-file'
import type { DeletedDiagram } from './deleted-diagrams'
import { acquireFile, registerFile, type FileLease } from './file-records'
import type { OpenLocalFile } from './file-session'

async function request(path: string, method: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(appUrl(path), { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? 'Операция не выполнена.')
  return data
}

/** После неопределённого HTTP-результата проверяем постоянную отметку операции. */
async function confirmRemoval(session: Session, operation: string, commit: () => Promise<DeletedDiagram>) {
  try { return await commit() }
  catch (error) {
    let response: Response
    try {
      response = await fetch(appUrl(`api/diagrams/${session.id}/generation`), { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    } catch {
      throw new Error('Не удалось подтвердить результат удаления. Не повторяй операцию до восстановления связи; записанный файл остаётся доступным.')
    }
    if (response.status === 410) {
      const deleted: DeletedDiagram = await response.json()
      await session.retire?.(deleted)
      if (deleted.operation === operation) return deleted
      throw new Error('Схему удалил другой участник.')
    }
    throw error
  }
}

export function StorageActions({ mode, close, returnFocus, session, title, requestIdentity, navigate, openLocal }: {
  mode: 'save' | 'delete' | null; close: () => void; returnFocus: () => void; session: Session; title: string
  requestIdentity: () => Promise<boolean>; navigate: (href: string) => Promise<void>
  openLocal: OpenLocalFile
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [transfer, setTransfer] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const running = useRef(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const removable = session.source === 'system' && session.id !== 'main' && session.canEdit && session.connected
  useEffect(() => {
    if (mode) { setTransfer(false); setError(''); dialog.current?.showModal() } else dialog.current?.close()
  }, [mode])
  async function execute() {
    if (running.current) return
    if (mode === 'save' && !transfer) {
      try { session.prepare?.(); downloadDiagram(session.doc, title); close() } catch (error) { setError(String(error)) }
      return
    }
    if (!removable) { setError('Удаление требует доступной системной схемы и соединения.'); return }
    running.current = true; setBusy(true); setError('')
    const controller = new AbortController(); pending.current = controller
    const { signal } = controller
    const operation = createUuid(), path = `api/diagrams/${session.id}`
    let prepared = false, written = false
    let lease: FileLease | undefined
    try {
      // Системный picker вызывается непосредственно из жеста. Если нужно знакомство,
      // возвращаемся в диалог: следующий явный click сохраняет user activation.
      if (!session.identity.name) {
        dialog.current?.close()
        const accepted = await requestIdentity()
        signal.throwIfAborted()
        dialog.current?.showModal()
        if (!accepted) return
        if (transfer) { setError('Теперь нажми «Перенести в файл»: выбор файла требует отдельного нажатия.'); return }
      }
      const selected = transfer ? await pickSaveFile(title) : undefined
      signal.throwIfAborted()
      session.prepare?.()
      if (selected) {
        lease = await acquireFile(await registerFile(selected.handle))
        signal.throwIfAborted()
        prepared = true
        const result = await request(`${path}/file-transfer`, 'POST', { generation: session.generation, operation }, signal)
        const text = JSON.stringify(result.file, null, 2) + '\n'
        await writeDiagramFile(selected.handle, selected.baseline, text, signal); written = true
        signal.throwIfAborted()
        const deleted = await confirmRemoval(session, operation, () => request(`${path}/file-transfer/${operation}/commit`, 'POST', undefined, signal))
        signal.throwIfAborted()
        await session.retire?.(deleted)
        await openLocal(selected.handle, text, lease)
        lease = undefined
      } else {
        const deleted = await confirmRemoval(session, operation, () => request(path, 'DELETE', { generation: session.generation, operation }, signal))
        signal.throwIfAborted()
        await session.retire?.(deleted)
        await navigate('./?choose=1')
      }
      close()
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setError(`${written ? 'Файл записан. ' : ''}${error instanceof Error ? error.message : String(error)}`)
    } finally {
      lease?.release()
      if (prepared && !session.deleted) void fetch(appUrl(`${path}/file-transfer/${operation}`), { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {})
      running.current = false; setBusy(false)
      pending.current = null
    }
  }
  return <dialog ref={dialog} className="diagrams-dialog file-dialog" aria-label={mode === 'delete' ? 'Удалить схему' : 'Сохранить схему в файл'}
    onClose={returnFocus}
    onCancel={event => { if (busy) event.preventDefault(); else close() }}>
    <h2>{mode === 'delete' ? 'Удалить схему' : 'Сохранить схему в файл'}</h2>
    <p>«{title}»</p>
    {mode === 'save' && <>
      <label><input type="checkbox" checked={transfer} disabled={busy || !removable || !canSaveDiskFile()} onChange={event => setTransfer(event.target.checked)} />Удалить из внутреннего хранилища и продолжить работу с файлом</label>
      {!canSaveDiskFile() && <p>Перенос требует HTTPS или локального запуска и браузера с прямой записью. Здесь можно скачать копию и отдельно удалить схему.</p>}
      {session.id === 'main' && <p>Основная схема защищена от удаления. Можно скачать копию.</p>}
    </>}
    {(mode === 'delete' || transfer) && <p>Схема будет удалена из системы для всех участников, без корзины и undo. Подключённые вкладки завершат синхронизацию; старые offline-правки не восстановят схему.{transfer && ' Удаление выполняется только после записи файла. Другие участники не переходят в файловую сессию автоматически.'}</p>}
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={() => { void execute() }}>{busy ? 'Выполняем…' : mode === 'delete' ? 'Удалить для всех' : transfer ? 'Перенести в файл' : 'Скачать копию'}</button>{' '}
    <button disabled={busy} onClick={close}>Отмена</button>
  </dialog>
}
