import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Request } from 'express'
import * as Y from 'yjs'
import { ZipFile as OutputZip } from 'yazl'
import { openPromise, type Entry, type ZipFile as InputZip } from 'yauzl'
import { createImportedDocument, getStructures, readText, ROOT_ID } from '../domain'
import {
  BACKUP_ARCHIVE_LIMIT,
  BACKUP_EXPANDED_LIMIT,
  BACKUP_FORMAT,
  BACKUP_ITEM_LIMIT,
  BACKUP_RESULT_LIMIT,
  BACKUP_VERSION,
  type BackupImportFailure,
  type BackupImportReplacement,
  type BackupImportResult,
  type BackupManifest,
  type BackupManifestItem,
} from '../shared/backup'
import { DIAGRAM_FILE_LIMIT, parseDiagramFile, serializeDiagram } from '../shared/diagram-file'
import { diagramTitle, isDiagramId } from '../shared/diagrams'
import { createUuid } from '../shared/uuid'
import { normalizeTrackerKey, trackerLabel } from '../shared/tracker'
import type { Hocuspocus } from '@hocuspocus/server'
import type { Replacements } from './replacement'
import type { TrackerStorage } from './tracker-storage'

const MANIFEST_PATH = 'manifest.json'
const MANIFEST_LIMIT = 16 * 1024 * 1024
const MANIFEST_TITLE_LIMIT = 500

export class BackupError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

interface ArchiveEntry {
  path: string
  stagedPath: string
}

interface PreparedArchive {
  directory: string
  path: string
  filename: string
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace('T', '_').replaceAll(':', '-')
}

function itemLabel(item: BackupManifestItem): string {
  return item.kind === 'tracker' ? trackerLabel(item.title, item.trackerKey) : item.title || item.id
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка восстановления.'
}

async function openArchive(path: string): Promise<InputZip> {
  try {
    return await openPromise(path, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true })
  } catch {
    throw new BackupError('Не удалось прочитать ZIP-архив.')
  }
}

async function readEntry(zip: InputZip, entry: Entry, limit: number): Promise<Buffer> {
  if (entry.uncompressedSize > limit) throw new BackupError(`Файл ${entry.fileName} превышает допустимый размер.`)
  const stream = await zip.openReadStreamPromise(entry)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) {
      stream.destroy()
      throw new BackupError(`Файл ${entry.fileName} превышает допустимый размер.`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}

function parseManifest(buffer: Buffer): BackupManifest {
  let value: unknown
  try { value = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '')) }
  catch { throw new BackupError('Не удалось прочитать manifest.json.') }
  if (!value || typeof value !== 'object') throw new BackupError('Некорректный manifest.json.')
  const source = value as Partial<BackupManifest>
  let normalizedDate: string | undefined
  try { if (typeof source.createdAt === 'string') normalizedDate = new Date(source.createdAt).toISOString() } catch { /* Некорректная дата. */ }
  if (source.format !== BACKUP_FORMAT || source.version !== BACKUP_VERSION || !normalizedDate
    || source.createdAt !== normalizedDate || !Array.isArray(source.items)) {
    throw new BackupError('Неизвестный формат или версия резервной копии.')
  }
  if (source.items.length > BACKUP_ITEM_LIMIT) throw new BackupError(`Архив содержит больше ${BACKUP_ITEM_LIMIT} схем.`, 413)
  const paths = new Set<string>(), ids = new Set<string>(), trackerKeys = new Set<string>()
  const items: BackupManifestItem[] = []
  for (const value of source.items) {
    if (!value || typeof value !== 'object') throw new BackupError('Некорректная запись в manifest.json.')
    const item = value as Partial<BackupManifestItem>
    if (!isDiagramId(item.id) || typeof item.title !== 'string' || item.title.length > MANIFEST_TITLE_LIMIT
      || (item.kind !== 'diagram' && item.kind !== 'tracker')) throw new BackupError('Некорректная запись в manifest.json.')
    const key = item.kind === 'tracker' ? normalizeTrackerKey(item.trackerKey) : null
    const expectedPath = item.kind === 'tracker' ? `tracker/${key}.deco` : `diagram/${item.id}.deco`
    if (item.path !== expectedPath || (item.kind === 'tracker' && key !== item.trackerKey)
      || paths.has(item.path) || ids.has(item.id) || (key !== null && trackerKeys.has(key))) {
      throw new BackupError('В manifest.json есть конфликтующие или некорректные записи.')
    }
    paths.add(item.path); ids.add(item.id)
    if (key !== null) trackerKeys.add(key)
    items.push(item as BackupManifestItem)
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: normalizedDate, items }
}

async function inspectArchive(path: string): Promise<BackupManifest> {
  const zip = await openArchive(path)
  const entries = new Map<string, Entry>()
  let expanded = 0
  let manifest: Buffer | undefined
  try {
    if (zip.entryCount > BACKUP_ITEM_LIMIT + 3) throw new BackupError(`Архив содержит больше ${BACKUP_ITEM_LIMIT} схем.`, 413)
    for await (const entry of zip.eachEntry()) {
      if (entry.isEncrypted() || !entry.canDecodeFileData()) throw new BackupError(`Не поддерживается ZIP-запись ${entry.fileName}.`)
      if (entries.has(entry.fileName)) throw new BackupError(`ZIP-архив содержит повторяющийся путь ${entry.fileName}.`)
      entries.set(entry.fileName, entry)
      expanded += entry.uncompressedSize
      if (!Number.isSafeInteger(expanded) || expanded > BACKUP_EXPANDED_LIMIT) {
        throw new BackupError('Распакованное содержимое архива превышает 2 ГиБ.', 413)
      }
      if (entry.fileName === MANIFEST_PATH) manifest = await readEntry(zip, entry, MANIFEST_LIMIT)
      else if (!entry.fileName.endsWith('/') && entry.uncompressedSize > DIAGRAM_FILE_LIMIT) {
        throw new BackupError(`Файл ${entry.fileName} превышает 5 МиБ.`, 413)
      }
    }
  } finally { zip.close() }
  if (!manifest) throw new BackupError('В архиве отсутствует manifest.json.')
  const parsed = parseManifest(manifest)
  const expected = new Set([MANIFEST_PATH, 'diagram/', 'tracker/', ...parsed.items.map(item => item.path)])
  for (const path of entries.keys()) {
    if (!expected.has(path)) throw new BackupError(`В архиве есть неизвестная запись ${path}.`)
  }
  for (const item of parsed.items) {
    if (!entries.has(item.path)) throw new BackupError(`В архиве отсутствует ${item.path}.`)
  }
  return parsed
}

export class BackupService {
  private busy = false

  constructor(private storage: TrackerStorage, private collaboration: Hocuspocus, private replacements: Replacements) {}

  private enter() {
    if (this.busy) throw new BackupError('Другая операция с резервной копией уже выполняется.', 409)
    this.busy = true
  }

  async createArchive(): Promise<PreparedArchive> {
    this.enter()
    let directory: string | undefined
    try {
      directory = await mkdtemp(join(tmpdir(), 'decompose-backup-'))
      const createdAt = new Date()
      const items: BackupManifestItem[] = []
      const files: ArchiveEntry[] = []
      const rows = this.storage.db!.prepare(`SELECT documents.name AS id, tracker_diagrams.tracker_key AS trackerKey
        FROM documents LEFT JOIN tracker_diagrams ON tracker_diagrams.document_id = documents.name
        ORDER BY CASE WHEN tracker_key IS NULL THEN 0 ELSE 1 END, documents.name`).all() as { id: string; trackerKey: string | null }[]
      if (rows.length > BACKUP_ITEM_LIMIT) throw new BackupError(`Хранилище содержит больше ${BACKUP_ITEM_LIMIT} схем.`, 413)
      await mkdir(join(directory, 'diagram')); await mkdir(join(directory, 'tracker'))
      for (const row of rows) {
        if (!isDiagramId(row.id)) throw new BackupError(`В хранилище найден документ с некорректным ID ${row.id}.`, 500)
        const trackerKey = row.trackerKey === null ? null : normalizeTrackerKey(row.trackerKey)
        if (row.trackerKey !== null && trackerKey !== row.trackerKey) {
          throw new BackupError(`В хранилище найден некорректный ключ задачи ${row.trackerKey}.`, 500)
        }
        const live = this.collaboration.documents.get(this.storage.currentName(row.id))
        const doc = live ?? new Y.Doc()
        try {
          if (!live) {
            const saved = this.storage.db!.prepare('SELECT data FROM documents WHERE name = ?').get(row.id) as { data: Buffer } | undefined
            if (!saved) throw new BackupError(`Документ ${row.id} исчез во время создания архива.`, 409)
            Y.applyUpdate(doc, saved.data)
          }
          const root = getStructures(doc).nodes.get(ROOT_ID)
          const title = diagramTitle(root ? readText(root) : '', trackerKey ?? undefined).slice(0, MANIFEST_TITLE_LIMIT)
          const path = trackerKey ? `tracker/${trackerKey}.deco` : `diagram/${row.id}.deco`
          const stagedPath = join(directory, path)
          await writeFile(stagedPath, serializeDiagram(doc))
          files.push({ path, stagedPath })
          items.push(trackerKey
            ? { kind: 'tracker', id: row.id, path, title, trackerKey }
            : { kind: 'diagram', id: row.id, path, title })
        } finally { if (!live) doc.destroy() }
      }
      const manifest: BackupManifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: createdAt.toISOString(), items }
      const manifestPath = join(directory, MANIFEST_PATH)
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
      const filename = `decompose-${timestamp(createdAt)}.zip`
      const archivePath = join(directory, filename)
      const zip = new OutputZip()
      const writing = pipeline(zip.outputStream as Readable, createWriteStream(archivePath))
      zip.addEmptyDirectory('diagram/', { mtime: createdAt })
      zip.addEmptyDirectory('tracker/', { mtime: createdAt })
      for (const file of files) zip.addFile(file.stagedPath, file.path, { mtime: createdAt })
      zip.addFile(manifestPath, MANIFEST_PATH, { mtime: createdAt })
      zip.end()
      await writing
      return { directory, path: archivePath, filename }
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true })
      throw error
    } finally { this.busy = false }
  }

  async receiveAndRestore(request: Request): Promise<BackupImportResult> {
    const directory = await mkdtemp(join(tmpdir(), 'decompose-restore-'))
    const archivePath = join(directory, 'upload.zip')
    try {
      const length = Number(request.headers['content-length'])
      if (Number.isFinite(length) && length > BACKUP_ARCHIVE_LIMIT) throw new BackupError('ZIP-архив превышает 512 МиБ.', 413)
      let size = 0
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          callback(size > BACKUP_ARCHIVE_LIMIT ? new BackupError('ZIP-архив превышает 512 МиБ.', 413) : null, chunk)
        },
      })
      await pipeline(request, limiter, createWriteStream(archivePath))
      if (!size) throw new BackupError('Выбран пустой файл.')
      return await this.restoreArchive(archivePath)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }

  private async restoreArchive(path: string): Promise<BackupImportResult> {
    this.enter()
    try {
      const manifest = await inspectArchive(path)
      const items = new Map(manifest.items.map(item => [item.path, item]))
      const failures: BackupImportFailure[] = [], replacements: BackupImportReplacement[] = []
      let loaded = 0, replaced = 0, failed = 0, processed = 0
      const zip = await openArchive(path)
      try {
        for await (const entry of zip.eachEntry()) {
          const item = items.get(entry.fileName)
          if (!item) continue
          processed++
          try {
            const file = parseDiagramFile((await readEntry(zip, entry, DIAGRAM_FILE_LIMIT)).toString('utf8'))
            const wasReplaced = await this.restoreItem(item, file)
            loaded++
            if (wasReplaced) {
              replaced++
              if (replacements.length < BACKUP_RESULT_LIMIT) replacements.push({ path: item.path, label: itemLabel(item) })
            }
          } catch (error) {
            failed++
            if (failures.length < BACKUP_RESULT_LIMIT) failures.push({ path: item.path, label: itemLabel(item), reason: failureMessage(error) })
          }
        }
      } finally { zip.close() }
      if (processed !== manifest.items.length) throw new BackupError('Не удалось прочитать все записи архива.')
      return {
        loaded, replaced, failed, failures, replacements,
        failuresTruncated: failed > failures.length,
        replacementsTruncated: replaced > replacements.length,
      }
    } finally { this.busy = false }
  }

  private async restoreItem(item: BackupManifestItem, file: ReturnType<typeof parseDiagramFile>): Promise<boolean> {
    if (item.kind === 'diagram') {
      if (this.storage.hasDocument(item.id)) {
        if (this.storage.trackerForDocument(item.id)) throw new BackupError('ID уже принадлежит дереву задачи.')
        await this.replacements.replace(item.id, this.storage.generation(item.id), file)
        return true
      }
      const deleted = this.storage.deleted(item.id)
      if (deleted?.trackerKey) throw new BackupError('ID принадлежал дереву задачи.')
      const doc = createImportedDocument(file)
      try { this.storage.restoreDocument(item.id, doc) } finally { doc.destroy() }
      return false
    }

    const existing = this.storage.findTracker(item.trackerKey)
    if (existing) {
      await this.replacements.replace(existing.id, this.storage.generation(existing.id), file)
      return true
    }
    let id = item.id
    const deleted = this.storage.deleted(id)
    if (this.storage.hasDocument(id) || (deleted && deleted.trackerKey !== item.trackerKey)) {
      do { id = createUuid() } while (this.storage.hasDocument(id) || this.storage.deleted(id))
    }
    const doc = createImportedDocument(file)
    try { this.storage.restoreDocument(id, doc, item.trackerKey) } finally { doc.destroy() }
    return false
  }
}

export async function removePreparedArchive(archive: PreparedArchive): Promise<void> {
  await rm(archive.directory, { recursive: true, force: true })
}

export function streamPreparedArchive(archive: PreparedArchive): Readable {
  return createReadStream(archive.path)
}
