import { createUuid } from '../shared/uuid'
import * as Y from 'yjs'
import { SQLite, schema, upsertQuery } from '@hocuspocus/extension-sqlite'
import type { onStoreDocumentPayload } from '@hocuspocus/server'
import { getStructures, initializeDocument, readText, ROOT_ID } from '../domain'
import { normalizeTitle } from '../shared/diagrams'
import { TRACKER_PAGE_SIZE, trackerSearch, type TrackerSummary, type TrackerPage } from '../shared/tracker'

const trackerSchema = `
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

export class TrackerStorage extends SQLite {
  constructor(database: string) { super({ database, schema: `${schema};${trackerSchema}` }) }

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

  ensureTracker(key: string): { item: TrackerSummary; created: boolean } {
    return this.db!.transaction(() => {
      const existing = this.findTracker(key)
      if (existing) return { item: existing, created: false }
      const doc = new Y.Doc()
      const id = createUuid()
      const updatedAt = Date.now()
      try {
        initializeDocument(doc)
        getStructures(doc).nodes.get(ROOT_ID)!.set('text', key)
        this.db!.prepare('INSERT INTO documents (name, data) VALUES (?, ?)').run(id, Buffer.from(Y.encodeStateAsUpdate(doc)))
        this.db!.prepare('INSERT INTO tracker_diagrams (tracker_key, document_id, title, search_text, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(key, id, key, trackerSearch(key), updatedAt)
      } finally { doc.destroy() }
      return { item: { id, trackerKey: key, title: key, updatedAt }, created: true }
    }).immediate()
  }

  override async onStoreDocument({ documentName, document }: onStoreDocumentPayload) {
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
