import type * as Y from 'yjs'
import { applyExternalSnapshot } from '../domain/external-snapshot'
import { DIAGRAM_FILE_LIMIT, diagramFilename, parseDiagramFile, sameDiagramFile, serializeDiagram, snapshotDiagram, type DiagramFile } from '../shared/diagram-file'
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
  const handle = await picker.call(window, { suggestedName: diagramFilename(title), types: [{ description: 'Схема дерево·дел', accept: { 'application/json': ['.deco'] } }] })
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
  const [handle] = await picker.call(window, { multiple: false, types: [{ description: 'Схема дерево·дел', accept: { 'application/json': ['.deco', '.json'] } }] })
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

export interface ExternalFileConflict {
  message: string
  external?: DiagramFile
  observedText: string
}

export interface FileAutosaveHooks {
  prepare?: () => boolean
  beforeExternal?: () => Promise<boolean>
  appliedExternal?: () => Promise<void> | void
  conflictChanged?: (conflict: ExternalFileConflict | undefined) => void
  clearHistory?: () => void
}

class ExternalConflictError extends Error {}

/** Очередь записей одного файла. Никаких скрытых копий содержимого в браузерных БД. */
export class FileAutosave {
  dirty = false
  saving = false
  error = ''
  conflict?: ExternalFileConflict
  private revision = 0
  private timer?: ReturnType<typeof setTimeout>
  private deadline?: ReturnType<typeof setTimeout>
  private pending?: Promise<void>
  private checking?: Promise<void>
  private closed = false
  private applyingExternal = false
  private hooks: FileAutosaveHooks = {}
  private poll?: ReturnType<typeof setInterval>
  constructor(readonly handle: WritableFile, private baseline: string, private doc: Y.Doc,
    private notify: () => void, private capture: () => number, private saved: (revision: number) => void) {
    parseDiagramFile(baseline)
    doc.on('update', this.changed)
    if (typeof window !== 'undefined') {
      this.poll = setInterval(this.visibleCheck, 2000)
      window.addEventListener('focus', this.visibleCheck)
      window.addEventListener('pageshow', this.visibleCheck)
      document.addEventListener('visibilitychange', this.visibleCheck)
    }
  }
  configure(hooks: FileAutosaveHooks) { this.hooks = { ...this.hooks, ...hooks } }
  private changed = () => {
    if (this.closed || this.applyingExternal) return
    this.dirty = true; this.revision++; this.notify()
    if (this.error || this.conflict) return
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
        const diskText = await (await this.handle.getFile()).text()
        if (diskText !== this.baseline) {
          await this.recordConflict(diskText)
          throw new ExternalConflictError(this.conflict!.message)
        }
        writable = await this.handle.createWritable(); await writable.write(text); await writable.close(); writable = undefined
        const written = await (await this.handle.getFile()).text()
        if (written !== text) throw new Error('Не удалось подтвердить запись файла на диске.')
        this.baseline = written; this.dirty = version !== this.revision; this.saved(serverRevision)
      } catch (error) {
        await writable?.abort().catch(() => {})
        this.dirty = true
        if (!(error instanceof ExternalConflictError)) this.error = error instanceof Error ? error.message : 'Не удалось сохранить файл.'
        throw error
      } finally { this.saving = false; this.pending = undefined; this.notify() }
    })
    await this.pending
    if (this.dirty) await this.save()
  }
  async retry() {
    if (this.conflict) throw new Error('Сначала разреши конфликт с файлом на диске.')
    if (await this.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Нет разрешения на запись.')
    await this.save(true)
  }
  async checkExternal(): Promise<void> {
    if (this.closed || this.checking || this.saving) return this.checking
    this.checking = this.inspectExternal().finally(() => { this.checking = undefined })
    return this.checking
  }
  async acceptExternal(): Promise<void> {
    const conflict = this.conflict
    if (!conflict?.external) throw new Error('Внешний файл нельзя применить, пока в нём есть ошибка.')
    const observedText = await (await this.handle.getFile()).text()
    if (observedText !== conflict.observedText) {
      await this.recordConflict(observedText)
      throw new Error('Файл снова изменился. Проверь обновлённый конфликт перед применением.')
    }
    const external = parseDiagramFile(observedText)
    try { await this.prepareExternal() }
    catch (error) {
      this.setConflict({ external, observedText, message: error instanceof Error
        ? `Внешнее изменение пока не применено: ${error.message}`
        : 'Внешнее изменение пока не применено.' })
      throw error
    }
    await this.applyExternal(external, observedText)
  }
  async overwriteExternal(): Promise<void> {
    const conflict = this.conflict
    if (!conflict) return
    const observedText = await (await this.handle.getFile()).text()
    if (observedText !== conflict.observedText) {
      await this.recordConflict(observedText)
      throw new Error('Файл снова изменился. Проверь обновлённый конфликт перед перезаписью.')
    }
    await this.prepareExternal()
    const text = serializeDiagram(this.doc)
    if (await this.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Нет разрешения на запись.')
    const writer = await this.handle.createWritable()
    try { await writer.write(text); await writer.close() } catch (error) { await writer.abort().catch(() => {}); throw error }
    const written = await (await this.handle.getFile()).text()
    if (written !== text) throw new Error('Не удалось подтвердить запись файла на диске.')
    try { await this.hooks.appliedExternal?.() }
    catch (error) {
      this.error = error instanceof Error ? error.message : 'Не удалось подтвердить обновление файловой сессии.'
      this.notify()
      throw error
    }
    this.baseline = written; this.dirty = false; this.error = ''
    this.setConflict(undefined); this.saved(this.capture())
    this.notify()
  }
  async waitForWrite() { await this.pending?.catch(() => {}) }
  destroy() {
    this.closed = true; clearTimeout(this.timer); clearTimeout(this.deadline); clearInterval(this.poll)
    this.doc.off('update', this.changed)
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.visibleCheck)
      window.removeEventListener('pageshow', this.visibleCheck)
      document.removeEventListener('visibilitychange', this.visibleCheck)
    }
  }

  private visibleCheck = () => {
    if (document.visibilityState === 'visible') void this.checkExternal().catch(error => {
      this.dirty = true
      this.error = error instanceof Error ? error.message : 'Не удалось проверить файл на диске.'
      this.notify()
    })
  }
  private async inspectExternal() {
    if (this.pending) await this.pending.catch(() => {})
    if (this.closed) return
    const observedText = await (await this.handle.getFile()).text()
    if (observedText === this.baseline) return
    let external: DiagramFile
    try { external = parseDiagramFile(observedText) }
    catch (error) {
      this.setConflict({ observedText, message: error instanceof Error
        ? `Файл на диске изменён, но его нельзя прочитать: ${error.message}`
        : 'Файл на диске изменён, но его нельзя прочитать.' })
      return
    }
    const baseline = parseDiagramFile(this.baseline)
    if (sameDiagramFile(external, baseline)) {
      this.baseline = observedText
      this.notify()
      return
    }
    try { await this.prepareExternal() }
    catch (error) {
      this.setConflict({ external, observedText, message: error instanceof Error
        ? `Внешнее изменение пока не применено: ${error.message}`
        : 'Внешнее изменение пока не применено.' })
      return
    }
    const latestText = await (await this.handle.getFile()).text()
    if (latestText !== observedText) { await this.recordConflict(latestText); return }
    const clean = !this.dirty && !this.saving && sameDiagramFile(snapshotDiagram(this.doc), baseline)
    if (!clean) {
      this.setConflict({ external, observedText,
        message: 'Файл на диске и открытая схема изменились независимо. Выбери, какие данные сохранить.' })
      return
    }
    await this.applyExternal(external, observedText)
  }
  private async prepareExternal() {
    if (this.hooks.prepare?.() === false) throw new Error('Сначала заверши редактирование карточки.')
    if (this.hooks.beforeExternal && !await this.hooks.beforeExternal()) throw new Error('Не удалось подготовить участников к обновлению файла.')
  }
  private async applyExternal(external: DiagramFile, observedText: string) {
    this.applyingExternal = true
    try { applyExternalSnapshot(this.doc, external) } finally { this.applyingExternal = false }
    this.hooks.clearHistory?.()
    try { await this.hooks.appliedExternal?.() }
    catch (error) {
      this.dirty = true
      this.error = error instanceof Error ? error.message : 'Не удалось подтвердить обновление файловой сессии.'
      this.notify()
      throw error
    }
    this.baseline = observedText
    this.dirty = false
    this.error = ''
    this.setConflict(undefined)
    this.notify()
  }
  private async recordConflict(observedText: string) {
    try {
      this.setConflict({ observedText, external: parseDiagramFile(observedText),
        message: 'Файл на диске и открытая схема изменились независимо. Выбери, какие данные сохранить.' })
    } catch (error) {
      this.setConflict({ observedText, message: error instanceof Error
        ? `Файл на диске изменён, но его нельзя прочитать: ${error.message}`
        : 'Файл на диске изменён, но его нельзя прочитать.' })
    }
  }
  private setConflict(conflict: ExternalFileConflict | undefined) {
    this.conflict = conflict
    this.hooks.conflictChanged?.(conflict)
    this.notify()
  }
}
