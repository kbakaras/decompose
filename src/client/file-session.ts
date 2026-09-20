import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { createImportedDocument } from '../domain'
import { parseDiagramFile, snapshotDiagram } from '../shared/diagram-file'
import { fileSessionUrl, localFileUrl } from '../shared/diagram-route'
import { createUuid } from '../shared/uuid'
import { Session } from './session-base'
import { FileAutosave, readDiagramText, type WritableFile } from './diagram-file'
import { appBaseUrl, appUrl } from './app-url'
import { collaborationUrl } from './collaboration-url'
import { acquireFile, FileBusy, FilePermission, findFileRecord, registerFile, saveFileRecord, type FileLease } from './file-records'

export type OpenLocalFile = (handle: WritableFile, text: string, lease?: FileLease) => Promise<void>

const endedFileNotice = 'Работаешь с файлом на диске. Изменения сохраняются автоматически. Совместный доступ приостановлен; ссылка сохранена. Чтобы возобновить его, выбери «Поделиться сессией» в меню файла.'
const encode = (doc: Y.Doc) => btoa(Array.from(Y.encodeStateAsUpdate(doc), byte => String.fromCharCode(byte)).join(''))

async function publishRoom(id: string, secret: string, doc: Y.Doc, signal?: AbortSignal): Promise<string> {
  const response = await fetch(appUrl('api/file-sessions'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ id, state: encode(doc) }), signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Не удалось открыть совместную сессию.')
  return result.name
}

async function restoreRoom(id: string, room: NonNullable<FileLease['record']['room']>, doc: Y.Doc, signal?: AbortSignal, replace = false): Promise<string> {
  const response = await fetch(appUrl(`api/file-sessions/${id}/restore`), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${room.secret}` },
    body: JSON.stringify({ state: encode(doc), replace }), signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Не удалось восстановить совместную сессию.')
  return result.name
}

function fileSession(lease: FileLease, text: string, doc = createImportedDocument(parseDiagramFile(text))): Session {
  const { record } = lease, handle = record.handle
  const session = new Session(record.id, doc, 'file')
  session.fileRecord = record
  session.fileUrl = appUrl(localFileUrl(record.id)).href
  session.release = async () => lease.release()
  session.file = new FileAutosave(handle, text, session.doc, () => {
    if (session.file?.error) session.provider?.sendStateless(JSON.stringify({ type: 'file-error' }))
    session.emit()
  }, () => session.fileRevision, revision => {
    if (session.connected) session.provider?.sendStateless(JSON.stringify({ type: 'file-saved', revision, fileName: handle.name }))
  })
  return session
}

export async function openFileSession(handle: WritableFile, _text: string, signal: AbortSignal, reserved?: FileLease): Promise<Session> {
  const lease = reserved ?? await acquireFile(await registerFile(handle))
  try {
    signal.throwIfAborted()
    if (lease.record.room?.base === appBaseUrl) return (await restoreFileSession(lease.record.id, false, signal, lease))!
    // Читаем после получения блокировки: выбор файла мог ждать завершения другой записи.
    const text = await readDiagramText(await handle.getFile())
    signal.throwIfAborted()
    return fileSession(lease, text)
  } catch (error) { lease.release(); throw error }
}

export async function restoreFileSession(id: string, shared: boolean, signal: AbortSignal, reserved?: FileLease): Promise<Session | null> {
  const record = reserved?.record ?? await findFileRecord(id, shared).catch(error => { if (!shared) throw error; return undefined })
  signal.throwIfAborted()
  if (!record) return shared ? openGuestSession(id, signal) : null
  let lease: FileLease
  try { lease = reserved ?? await acquireFile(record) }
  catch (error) { if (shared && error instanceof FileBusy) return openGuestSession(id, signal); throw error }
  try {
    if (await record.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new FilePermission(record)
    const text = await readDiagramText(await record.handle.getFile())
    signal.throwIfAborted()
    const room = record.room?.base === appBaseUrl ? record.room : undefined
    if (!room) return fileSession(lease, text)
    let response: Response
    for (let attempt = 0; ; attempt++) {
      response = await fetch(appUrl(`api/file-sessions/${record.id}/resume`), {
        headers: { Authorization: `Bearer ${room.secret}` }, cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      })
      if (response.status !== 409 || attempt === 3) break
      // При reload старый WebSocket может закрыться чуть позже загрузки оболочки.
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)))
      signal.throwIfAborted()
    }
    if (response.status === 404 || response.status === 410) {
      const doc = createImportedDocument(parseDiagramFile(text))
      try {
        const name = response.status === 404
          ? await publishRoom(record.id, room.secret, doc, signal)
          : await restoreRoom(record.id, room, doc, signal)
        signal.throwIfAborted()
        const session = fileSession(lease, text, doc)
        session.roomUrl = appUrl(fileSessionUrl(record.id)).href
        connectRoom(session, record.id, room.secret, name)
        return session
      } catch (error) { doc.destroy(); throw error }
    }
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Не удалось восстановить файловую сессию.')
    signal.throwIfAborted()
    let doc = new Y.Doc(), name = result.name
    try {
      Y.applyUpdate(doc, Uint8Array.from(atob(result.state), char => char.charCodeAt(0)))
      const disk = JSON.stringify(parseDiagramFile(text))
      // Запись могла завершиться перед reload, а её подтверждение — не дойти до сервера.
      if (disk !== result.saved && disk !== JSON.stringify(snapshotDiagram(doc))) {
        if (!reserved) throw new Error('Файл отличается от последнего сохранения сессии. Автоматическое восстановление остановлено: файл не перезаписан. Открой его заново через выбор файла.')
        // Явный выбор файла делает его источником нового поколения вместо старого снимка.
        doc.destroy(); doc = createImportedDocument(parseDiagramFile(text))
        name = await restoreRoom(record.id, room, doc, signal, true)
        signal.throwIfAborted()
      }
    } catch (error) { doc.destroy(); throw error }
    const session = fileSession(lease, text, doc)
    session.file!.dirty = JSON.stringify(parseDiagramFile(text)) !== JSON.stringify(snapshotDiagram(doc))
    session.roomUrl = appUrl(fileSessionUrl(record.id)).href
    connectRoom(session, record.id, room.secret, name)
    return session
  } catch (error) {
    lease.release()
    if (error instanceof DOMException && error.name === 'NotFoundError') throw new Error('Файл перемещён или удалён. Выбери файл заново.')
    if (error instanceof DOMException && error.name === 'NotAllowedError') throw new FilePermission(record)
    throw error
  }
}

function connectRoom(session: Session, id: string, secret?: string, name = id) {
  const socketUrl = new URL(collaborationUrl(appBaseUrl))
  socketUrl.pathname = appUrl('file-collaboration').pathname
  let connectedOnce = false, syncedOnce = false, roomActive = false, rejected = false
  let hasLocalEdits = false
  session.blocked = session.source === 'guest'
  const provider = new HocuspocusProvider({
    url: socketUrl.href, name, document: session.doc, token: secret ?? '',
    onAuthenticationFailed: () => {
      session.ended = !secret; session.roomUrl = ''
      if (secret) session.fileNotice = endedFileNotice
      else session.message = 'Это подключение завершено. Скачай копию нужных правок и открой актуальную схему по той же ссылке.'
      session.emit()
    },
    onStatus: ({ status }) => {
      if (status === 'connected') connectedOnce = true
      if (status === 'disconnected' && connectedOnce && session.source === 'guest' && !session.ended) {
        session.prepare?.(); session.ended = true; session.blocked = true
        session.message = 'Связь прервана. Скачай копию несохранённых правок или подключись заново.'
        queueMicrotask(() => provider.disconnect()); session.emit()
      }
    },
    onSynced: ({ state }) => {
      if (!state) return
      syncedOnce = true
      if (secret && !session.file?.error) void session.file?.save(true).catch(() => {})
    },
    onStateless: ({ payload }) => {
      let message
      try { message = JSON.parse(payload) } catch { return }
      if (message.type === 'file-state') {
        session.fileRevision = message.revision
        if (typeof message.fileName === 'string') session.fileName = message.fileName
        if (secret) {
          if (!message.active && syncedOnce && !session.file?.error) void session.file?.save(true).catch(() => {})
        } else {
          if (!message.active) session.prepare?.()
          if (!roomActive && message.active && hasLocalEdits && provider.hasUnsyncedChanges) rejected = true
          session.blocked = !message.active || rejected
          session.message = session.blocked ? 'Запись в файл приостановлена. Доступны просмотр и скачивание копии.' : ''
          roomActive = !!message.active
        }
      } else if (message.type === 'file-ended') {
        if (!secret) { session.prepare?.(); session.ended = true }
        session.roomUrl = ''
        if (secret) session.fileNotice = endedFileNotice
        else session.message = 'Совместная сессия завершена. Ссылка сохранена. Скачай копию нужных правок и открой актуальную схему; если файл не открыт, она будет ожидать владельца.'
        provider.disconnect()
      } else if (message.type === 'file-paused' && !secret) {
        session.prepare?.(); session.blocked = true
        if (hasLocalEdits && provider.hasUnsyncedChanges) rejected = true
        session.message = 'Правки не приняты: запись в файл недоступна. Скачай копию или подключись заново.'
      }
      session.emit()
    },
  })
  if (!secret) {
    // Счётчик Hocuspocus включает начальный sync, даже без пользовательских правок.
    const localUpdate = (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
      if (transaction.local) hasLocalEdits = true
    }
    session.doc.on('update', localUpdate)
    provider.on('unsyncedChanges', ({ number }: { number: number }) => { if (number === 0) hasLocalEdits = false })
    provider.on('destroy', () => session.doc.off('update', localUpdate))
  }
  session.attach(provider)
  if (secret) session.roomClose = () => provider.sendStateless(JSON.stringify({ type: 'file-close' }))
}

export async function shareFileSession(session: Session) {
  if (!session.file || session.source !== 'file') throw new Error('Открой файл для редактирования.')
  if (session.roomUrl && !session.ended) return session.roomUrl
  await session.flush()
  // Начальная контрольная копия комнаты должна совпадать с реальным файлом.
  await session.file.save(true)
  if (!session.fileRecord) throw new Error('Не удалось запомнить владельца файла.')
  if (session.closed) throw new Error('Файл уже закрыт.')
  const id = session.fileRecord.id
  const room = { secret: session.fileRecord.room?.secret ?? createUuid() + createUuid(), base: appBaseUrl }
  // Сохраняем реквизиты до запроса: потерянный ответ не должен потерять владельца.
  session.fileRecord.room = room
  await saveFileRecord(session.fileRecord)
  if (session.closed) throw new Error('Файл уже закрыт.')
  const { secret } = room
  const name = await publishRoom(id, secret, session.doc)
  if (session.closed) throw new Error('Файл уже закрыт.')
  session.provider?.destroy(); session.ended = false
  session.fileNotice = ''
  session.roomUrl = appUrl(fileSessionUrl(id)).href
  connectRoom(session, id, secret, name)
  session.emit()
  return session.roomUrl
}

/** Дожидаемся последних принятых обновлений перед снимком файла для внутренней схемы. */
export async function finishFileSharing(session: Session, signal: AbortSignal) {
  if (!session.roomUrl) return
  if (!session.connected || !session.provider || !session.roomClose) throw new Error('Нет связи с файловой сессией. Восстанови соединение перед переносом.')
  await session.synced()
  signal.throwIfAborted()
  if (!session.roomUrl) return
  const provider = session.provider
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); provider.off('stateless', received); signal.removeEventListener('abort', aborted)
      if (error) reject(error); else resolve()
    }
    const received = ({ payload }: { payload: string }) => {
      try { if (JSON.parse(payload).type === 'file-ended') finish() } catch { /* Не сообщение завершения. */ }
    }
    const aborted = () => finish(new DOMException('Переход отменён', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('Не удалось подтвердить завершение файловой сессии. Повтори после восстановления связи.')), 10000)
    provider.on('stateless', received); signal.addEventListener('abort', aborted, { once: true })
    session.roomClose!()
  })
}

export async function openGuestSession(id: string, signal: AbortSignal) {
  const lookup = async (signal: AbortSignal) => {
    const response = await fetch(appUrl(`api/file-sessions/${id}`), { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) })
    if (!response.ok) throw new Error(response.status === 404 ? 'Ссылка файловой сессии не найдена.' : 'Не удалось проверить файловую сессию.')
    return await response.json() as { name: string | null; fileName?: string }
  }
  const room = await lookup(signal)
  signal.throwIfAborted()
  const session = new Session(id, new Y.Doc(), 'guest')
  session.fileName = room.fileName ?? ''
  if (room.name) connectRoom(session, id, undefined, room.name)
  else {
    session.waitingForOwner = true; session.blocked = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const room = await lookup(controller.signal)
        if (controller.signal.aborted) return
        if (room.fileName && room.fileName !== session.fileName) { session.fileName = room.fileName; session.emit() }
        if (room.name) {
          session.waitingForOwner = false
          connectRoom(session, id, undefined, room.name)
          session.emit()
          return
        }
      } catch { if (controller.signal.aborted) return }
      timer = setTimeout(() => { void poll() }, 1500)
    }
    timer = setTimeout(() => { void poll() }, 1500)
    session.release = async () => { controller.abort(); clearTimeout(timer) }
  }
  return session
}
