import { createUuid } from '../shared/uuid'
import * as Y from 'yjs'
import { SQLite, schema, upsertQuery } from '@hocuspocus/extension-sqlite'
import type { onLoadDocumentPayload, onStoreDocumentPayload } from '@hocuspocus/server'
import { documentName, parseDocumentName } from '../shared/document-generation'
import { getStructures, initializeDocument, readText, ROOT_ID } from '../domain'
import { normalizeTitle } from '../shared/diagrams'
import { TRACKER_PAGE_SIZE, trackerSearch, type TrackerSummary, type TrackerPage } from '../shared/tracker'

const trackerSchema = `
CREATE TABLE IF NOT EXISTS file_sessions (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_generations (name TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deleted_documents (
  id TEXT PRIMARY KEY, generation INTEGER NOT NULL, tracker_key TEXT,
  operation TEXT NOT NULL, deleted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deleted_tracker_key ON deleted_documents(tracker_key);
CREATE TABLE IF NOT EXISTS tracker_diagrams (
  tracker_key TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(name),
  title TEXT NOT NULL,
  search_text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tracker_recent ON tracker_diagrams(updated_at DESC, tracker_key ASC);
`
const summaryColumns = `document_id AS id, tracker_key AS trackerKey,
  CASE WHEN title = '' THEN tracker_key ELSE title END AS title, updated_at AS updatedAt`

export interface DeletedDocument { id: string; generation: number; trackerKey: string | null; operation: string }
export class StorageConflict extends Error { readonly status = 409 }

export class TrackerStorage extends SQLite {
  constructor(database: string) { super({ database, schema: `${schema};${trackerSchema}` }) }

  private configured?: Promise<void>
  override onConfigure(): Promise<void> {
    return this.configured ??= super.onConfigure().then(() => {
      // Удаляем только прежний стартовый документ; он больше не является допустимой схемой.
      this.db!.transaction(() => {
        this.db!.prepare('DELETE FROM tracker_diagrams WHERE document_id = ?').run('main')
        this.db!.prepare('DELETE FROM documents WHERE name = ?').run('main')
        this.db!.prepare('DELETE FROM document_generations WHERE name = ?').run('main')
        this.db!.prepare('DELETE FROM deleted_documents WHERE id = ?').run('main')
      })()
    })
  }

  fileSessionHash(id: string): string | undefined {
    return (this.db!.prepare('SELECT secret_hash FROM file_sessions WHERE id = ?').get(id) as { secret_hash: string } | undefined)?.secret_hash
  }

  registerFileSession(id: string, hash: string) {
    this.db!.prepare('INSERT INTO file_sessions (id, secret_hash) VALUES (?, ?)').run(id, hash)
  }

  generation(id: string): number {
    return (this.db!.prepare('SELECT generation FROM document_generations WHERE name = ?').get(id) as { generation: number } | undefined)?.generation ?? 0
  }

  currentName(id: string): string { return documentName(id, this.generation(id)) }

  deleted(id: string): DeletedDocument | undefined {
    return this.db!.prepare('SELECT id, generation, tracker_key AS trackerKey, operation FROM deleted_documents WHERE id = ?').get(id) as DeletedDocument | undefined
  }

  deletedTracker(key: string): DeletedDocument | undefined {
    return this.db!.prepare('SELECT id, generation, tracker_key AS trackerKey, operation FROM deleted_documents WHERE tracker_key = ? ORDER BY rowid DESC LIMIT 1').get(key) as DeletedDocument | undefined
  }

  remove(id: string, expected: number, operation: string): DeletedDocument {
    return this.db!.transaction(() => {
      const previous = this.deleted(id)
      if (previous && previous.operation === operation) return previous
      if (!this.accepts(documentName(id, expected))) throw new StorageConflict('Схема удалена или изменилось её поколение.')
      const generation = expected + 1, trackerKey = this.trackerForDocument(id)?.trackerKey ?? null
      this.db!.prepare('INSERT INTO deleted_documents (id, generation, tracker_key, operation, deleted_at) VALUES (?, ?, ?, ?, ?)').run(id, generation, trackerKey, operation, Date.now())
      this.db!.prepare('INSERT INTO document_generations (name, generation) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET generation = excluded.generation').run(id, generation)
      this.db!.prepare('DELETE FROM tracker_diagrams WHERE document_id = ?').run(id)
      this.db!.prepare('DELETE FROM documents WHERE name = ?').run(id)
      return { id, generation, trackerKey, operation }
    })()
  }

  accepts(name: string): boolean {
    const parsed = parseDocumentName(name)
    return !!parsed && !this.deleted(parsed.id) && this.generation(parsed.id) === parsed.generation
      && !!this.db!.prepare('SELECT 1 FROM documents WHERE name = ?').get(parsed.id)
  }

  override async onLoadDocument({ documentName: name, document }: onLoadDocumentPayload) {
    if (!this.accepts(name)) throw new Error('Устаревшее поколение документа')
    const { id } = parseDocumentName(name)!
    const row = this.db!.prepare('SELECT data FROM documents WHERE name = ?').get(id) as { data: Buffer }
    Y.applyUpdate(document, row.data)
  }

  replace(id: string, expected: number, doc: Y.Doc): number {
    return this.db!.transaction(() => {
      if (!this.accepts(documentName(id, expected))) throw new Error('Схема уже была заменена')
      const next = expected + 1
      this.db!.prepare('INSERT INTO document_generations (name, generation) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET generation = excluded.generation').run(id, next)
      this.save(id, doc)
      return next
    })()
  }

  findTracker(key: string): TrackerSummary | undefined {
    return this.db!.prepare(`SELECT ${summaryColumns} FROM tracker_diagrams WHERE tracker_key = ?`).get(key) as TrackerSummary | undefined
  }

  trackerForDocument(id: string): TrackerSummary | undefined {
    return this.db!.prepare(`SELECT ${summaryColumns} FROM tracker_diagrams WHERE document_id = ?`).get(id) as TrackerSummary | undefined
  }

  listTracker(query: string, offset: number): TrackerPage {
    const rows = this.db!.prepare(`SELECT ${summaryColumns} FROM tracker_diagrams
      WHERE instr(search_text, ?) > 0
      ORDER BY updated_at DESC, tracker_key ASC LIMIT ? OFFSET ?`)
      .all(trackerSearch(query), TRACKER_PAGE_SIZE + 1, offset) as TrackerSummary[]
    return { items: rows.slice(0, TRACKER_PAGE_SIZE), nextOffset: rows.length > TRACKER_PAGE_SIZE ? offset + TRACKER_PAGE_SIZE : null }
  }

  ensureTracker(key: string, recreateDeletedId?: string): { item: TrackerSummary; created: boolean } {
    return this.db!.transaction(() => {
      const existing = this.findTracker(key)
      if (existing) return { item: existing, created: false }
      const deleted = this.deletedTracker(key)
      if (deleted && deleted.id !== recreateDeletedId) throw new StorageConflict('Дерево задачи удалено. Подтверди создание нового дерева.')
      const doc = new Y.Doc()
      const id = createUuid()
      const updatedAt = Date.now()
      try {
        initializeDocument(doc, 'center')
        getStructures(doc).nodes.get(ROOT_ID)!.set('text', key)
        this.db!.prepare('INSERT INTO documents (name, data) VALUES (?, ?)').run(id, Buffer.from(Y.encodeStateAsUpdate(doc)))
        this.db!.prepare('INSERT INTO tracker_diagrams (tracker_key, document_id, title, search_text, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(key, id, key, trackerSearch(key), updatedAt)
      } finally { doc.destroy() }
      return { item: { id, trackerKey: key, title: key, updatedAt }, created: true }
    }).immediate()
  }

  override async onStoreDocument({ documentName: name, document }: onStoreDocumentPayload) {
    // Запоздалый debounce или unload старого поколения не перезаписывает новое.
    const parsed = parseDocumentName(name)
    if (!parsed || this.deleted(parsed.id) || this.generation(parsed.id) !== parsed.generation) return
    this.save(parsed.id, document)
  }

  private save(documentName: string, document: Y.Doc) {
    const state = Buffer.from(Y.encodeStateAsUpdate(document))
    this.db!.transaction(() => {
      const previous = this.db!.prepare('SELECT data FROM documents WHERE name = ?').get(documentName) as { data: Buffer } | undefined
      // Открытие и повторная запись того же состояния не поднимают задачу в списке.
      if (previous?.data.equals(state)) return
      this.db!.prepare(upsertQuery).run({ name: documentName, data: state })
      const tracker = this.trackerForDocument(documentName)
      if (tracker) {
        const root = getStructures(document).nodes.get(ROOT_ID)
        const title = normalizeTitle(root ? readText(root) : '')
        this.db!.prepare('UPDATE tracker_diagrams SET title = ?, search_text = ?, updated_at = ? WHERE document_id = ?')
          .run(title, `${trackerSearch(tracker.trackerKey)}\n${trackerSearch(title)}`, Date.now(), documentName)
      }
    })()
  }
}
