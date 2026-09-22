import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createBackend } from '../../src/server/app'
import { createTestDiagram, TEST_CLIENT_DIR } from './helpers'

it('serves home without creating a document and retires only main on every startup', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-home-'))
  let backend = createBackend({ dataDir, clientDir: TEST_CLIENT_DIR })
  try {
    let url = `http://127.0.0.1:${await backend.listen(0)}`
    expect((await fetch(url)).status).toBe(200)
    expect(await (await fetch(`${url}/api/diagrams`)).json()).toEqual([])
    const id = await createTestDiagram(url, 'Сохранить обычную схему')
    await backend.close()
    const db = new DatabaseSync(join(dataDir, 'decompose.sqlite'))
    try {
      db.prepare('INSERT INTO documents (name, data) SELECT ?, data FROM documents WHERE name = ?').run('main', id)
      db.prepare('INSERT INTO document_generations (name, generation) VALUES (?, ?)').run('main', 2)
    } finally { db.close() }
    for (let attempt = 0; attempt < 2; attempt++) {
      backend = createBackend({ dataDir, clientDir: TEST_CLIENT_DIR })
      url = `http://127.0.0.1:${await backend.listen(0)}`
      expect(await (await fetch(`${url}/api/diagrams`)).json()).toEqual([{ id, title: 'Сохранить обычную схему' }])
      expect((await fetch(`${url}/api/diagrams/main`)).status).toBe(404)
      await backend.close()
    }
    const checked = new DatabaseSync(join(dataDir, 'decompose.sqlite'))
    try {
      expect(checked.prepare('SELECT name FROM documents').all().map(row => row.name)).toEqual([id])
      expect(checked.prepare('SELECT name FROM document_generations WHERE name = ?').all('main')).toEqual([])
    } finally { checked.close() }
  } finally {
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30000)
