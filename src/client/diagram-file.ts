import type * as Y from 'yjs'
import { DIAGRAM_FILE_LIMIT, diagramFilename, parseDiagramFile, serializeDiagram } from '../shared/diagram-file'
import { getStructures, readText, ROOT_ID } from '../domain/schema'
import { diagramTitle } from '../shared/diagrams'

export interface WritableFile {
  name: string
  isSameEntry?(other: WritableFile): Promise<boolean>
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>
}
interface FilePickerWindow extends Window {
  showOpenFilePicker?: (options: unknown) => Promise<WritableFile[]>
  showSaveFilePicker?: (options: unknown) => Promise<WritableFile>
}
export function canSaveDiskFile(): boolean { return isSecureContext && typeof (window as FilePickerWindow).showSaveFilePicker === 'function' }
export async function pickSaveFile(title: string) {
  const picker = (window as FilePickerWindow).showSaveFilePicker
  if (!canSaveDiskFile() || !picker) throw new Error('Для переноса нужны HTTPS или локальный запуск и браузер с прямой записью файлов.')
  const handle = await picker.call(window, { suggestedName: diagramFilename(title), types: [{ description: 'Схема дерево·дел', accept: { 'application/json': ['.json'] } }] })
  if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Нет разрешения на запись.')
  return { handle, baseline: await (await handle.getFile()).text() }
}
export async function writeDiagramFile(handle: WritableFile, baseline: string, text: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  parseDiagramFile(text)
  if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Нет разрешения на запись.')
  if (await (await handle.getFile()).text() !== baseline) throw new Error('Файл изменён другой программой. Перенос отменён.')
  const writer = await handle.createWritable()
  try { signal?.throwIfAborted(); await writer.write(text); signal?.throwIfAborted(); await writer.close() }
  catch (error) { await writer.abort().catch(() => {}); throw error }
}
export function canEditDiskFile(): boolean { return isSecureContext && typeof (window as FilePickerWindow).showOpenFilePicker === 'function' }
export async function pickWritableFile() {
  const picker = (window as FilePickerWindow).showOpenFilePicker
  if (!canEditDiskFile() || !picker) throw new Error('Запись в исходный файл требует HTTPS или локального запуска и браузера с File System Access API, например Chrome/Edge. Здесь можно скачать или импортировать копию.')
  const [handle] = await picker.call(window, { multiple: false, types: [{ description: 'Схема дерево·дел', accept: { 'application/json': ['.json'] } }] })
  if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Нет разрешения на запись в файл.')
  return { handle, text: await readDiagramText(await handle.getFile()) }
}
export async function readDiagramText(file: File) {
  if (file.size > DIAGRAM_FILE_LIMIT) throw new Error('Файл превышает 5 МиБ.')
  const text = await file.text(); parseDiagramFile(text); return text
}
export function downloadDiagram(doc: Y.Doc, title: string) {
  const url = URL.createObjectURL(new Blob([serializeDiagram(doc)], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  const root = getStructures(doc).nodes.get(ROOT_ID)
  anchor.href = url; anchor.download = diagramFilename(diagramTitle(root ? readText(root) : '', title))
  document.body.append(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

/** Очередь записей одного файла. Никаких скрытых копий содержимого в браузерных БД. */
export class FileAutosave {
  dirty = false
  saving = false
  error = ''
  private revision = 0
  private timer?: ReturnType<typeof setTimeout>
  private deadline?: ReturnType<typeof setTimeout>
  private pending?: Promise<void>
  private closed = false
  constructor(readonly handle: WritableFile, private baseline: string, private doc: Y.Doc,
    private notify: () => void, private capture: () => number, private saved: (revision: number) => void) { doc.on('update', this.changed) }
  private changed = () => {
    if (this.closed) return
    this.dirty = true; this.revision++; this.notify()
    if (this.error) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.save().catch(() => {}) }, 500)
    this.deadline ??= setTimeout(() => { void this.save().catch(() => {}) }, 2000)
  }
  async save(force = false): Promise<void> {
    if (this.closed) return
    if (this.pending) { await this.pending; if (this.dirty) await this.save(); return }
    if (!this.dirty && !force) return
    clearTimeout(this.timer); clearTimeout(this.deadline); this.deadline = undefined
    this.saving = true; this.error = ''; this.notify()
    const version = this.revision, serverRevision = this.capture()
    this.pending = Promise.resolve().then(async () => {
      let writable: Awaited<ReturnType<WritableFile['createWritable']>> | undefined
      try {
        const text = serializeDiagram(this.doc)
        if (await this.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Разрешение на запись отозвано. Нажми «Повторить сохранение».')
        if (await (await this.handle.getFile()).text() !== this.baseline) throw new Error('Файл изменён другой программой. Скачай копию или открой файл заново; исходный файл не перезаписан.')
        writable = await this.handle.createWritable(); await writable.write(text); await writable.close(); writable = undefined
        this.baseline = text; this.dirty = version !== this.revision; this.saved(serverRevision)
      } catch (error) {
        await writable?.abort().catch(() => {})
        this.dirty = true; this.error = error instanceof Error ? error.message : 'Не удалось сохранить файл.'
        throw error
      } finally { this.saving = false; this.pending = undefined; this.notify() }
    })
    await this.pending
    if (this.dirty) await this.save()
  }
  async retry() {
    if (await this.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Нет разрешения на запись.')
    await this.save(true)
  }
  async waitForWrite() { await this.pending?.catch(() => {}) }
  destroy() { this.closed = true; clearTimeout(this.timer); clearTimeout(this.deadline); this.doc.off('update', this.changed) }
}
