import { useEffect, useRef, useState } from 'react'
import type { Session } from './session'
import { appUrl } from './app-url'
import { createUuid } from '../shared/uuid'
import { canSaveDiskFile, pickSaveFile, writeDiagramFile } from './diagram-file'
import type { DeletedDiagram } from './deleted-diagrams'
import { acquireFile, registerFile, type FileLease } from './file-records'
import { finishFileSharing, type OpenLocalFile } from './file-session'
import { diagramUrl, isDiagramId } from '../shared/diagrams'
import { snapshotDiagram } from '../shared/diagram-file'

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

export type StorageAction = 'transfer' | 'internal' | 'delete'

export function StorageActions({ mode, close, returnFocus, session, title, requestIdentity, navigate, openLocal }: {
  mode: StorageAction | null; close: () => void; returnFocus: () => void; session: Session; title: string
  requestIdentity: () => Promise<boolean>; navigate: (href: string) => Promise<void>
  openLocal: OpenLocalFile
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const transfer = mode === 'transfer'
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const createdId = useRef<string | null>(null)
  const running = useRef(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const removable = session.source === 'system' && session.id !== 'main' && session.canEdit && session.connected
  useEffect(() => {
    if (mode) { createdId.current = null; setError(''); dialog.current?.showModal() } else dialog.current?.close()
  }, [mode])
  async function saveInternally() {
    if (running.current || !session.file || !navigator.onLine) return
    running.current = true; setBusy(true); setError('')
    const controller = new AbortController(); pending.current = controller
    const { signal } = controller, wasBlocked = session.blocked
    try {
      dialog.current?.close()
      const accepted = await requestIdentity()
      signal.throwIfAborted()
      dialog.current?.showModal()
      if (!accepted) return
      session.prepare?.(); session.blocked = true; session.emit()
      if (!createdId.current) {
        await finishFileSharing(session, signal)
        signal.throwIfAborted()
        await session.file.save(true)
        signal.throwIfAborted()
        const result = await request('api/diagrams/import', 'POST', snapshotDiagram(session.doc), signal)
        if (!isDiagramId(result.id)) throw new Error('Сервер не вернул ID внутренней схемы. Проверь каталог перед повтором.')
        createdId.current = result.id
      }
      signal.throwIfAborted()
      // Переход сам дожидается записи и освобождает дескриптор; при ошибке остаёмся в файле.
      const destination = createdId.current
      if (!destination) throw new Error('Не удалось получить адрес внутренней схемы.')
      await navigate(diagramUrl(destination))
      if (!session.closed) throw new Error('Внутренняя схема создана, но не открылась. Повтори переход.')
      close()
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setError(`${error instanceof Error ? error.message : String(error)} Файл остаётся на диске. Если связь прервалась, проверь каталог перед повторным созданием.`)
    } finally {
      session.blocked = wasBlocked; session.emit()
      running.current = false; setBusy(false); pending.current = null
    }
  }
  async function execute() {
    if (running.current || !mode) return
    if (mode === 'internal') { await saveInternally(); return }
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
  const heading = mode === 'delete' ? 'Удалить схему' : transfer ? 'Перенести схему в файл' : 'Сохранить как внутреннюю схему'
  return <dialog ref={dialog} className="diagrams-dialog file-dialog" aria-label={heading}
    onClose={returnFocus}
    onCancel={event => { if (busy) event.preventDefault(); else close() }}>
    <h2>{heading}</h2>
    <p>«{title}»</p>
    {transfer && <>
      <p>Сохранить на диск, удалить внутреннюю схему и продолжить редактирование файла.</p>
      {!canSaveDiskFile() && <p>Перенос требует HTTPS или локального запуска и браузера с прямой записью. Здесь можно скачать копию и отдельно удалить схему.</p>}
      {session.id === 'main' && <p>Основная схема защищена от удаления. Можно скачать копию.</p>}
    </>}
    {mode === 'internal' && <p>Текущие изменения сохранятся на диск, затем откроется независимая внутренняя схема. Файл останется на диске, но редактор отключится от него. Совместная файловая сессия завершится; участники не перейдут во внутреннюю схему автоматически.</p>}
    {(mode === 'delete' || transfer) && <p>Схема будет удалена из системы для всех участников, без корзины и undo. Подключённые вкладки завершат синхронизацию; старые offline-правки не восстановят схему.{transfer && ' Удаление выполняется только после записи файла. Другие участники не переходят в файловую сессию автоматически.'}</p>}
    {error && <p role="alert">{error}</p>}
    <button disabled={busy || transfer && (!removable || !canSaveDiskFile()) || mode === 'internal' && !navigator.onLine} onClick={() => { void execute() }}>{busy ? 'Выполняем' : mode === 'delete' ? 'Удалить для всех' : transfer ? 'Перенести в файл' : createdId.current ? 'Открыть созданную схему' : 'Сохранить и перейти'}</button>{' '}
    <button disabled={busy} onClick={close}>Отмена</button>
  </dialog>
}
