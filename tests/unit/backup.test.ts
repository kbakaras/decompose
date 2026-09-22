import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { ZipFile as OutputZip } from 'yazl'
import { fromBufferPromise } from 'yauzl'
import { createBackend } from '../../src/server/app'
import type { BackupManifest } from '../../src/shared/backup'
import { BACKUP_FORMAT, BACKUP_VERSION } from '../../src/shared/backup'
import { parseDiagramFile } from '../../src/shared/diagram-file'
import type { DiagramSummary } from '../../src/shared/diagrams'

async function zipEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await fromBufferPromise(buffer, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true })
  const result = new Map<string, Buffer>()
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith('/')) { result.set(entry.fileName, Buffer.alloc(0)); continue }
      const stream = await zip.openReadStreamPromise(entry)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      result.set(entry.fileName, Buffer.concat(chunks))
    }
  } finally { zip.close() }
  return result
}

async function makeZip(files: Map<string, string>): Promise<Buffer> {
  const zip = new OutputZip()
  for (const [path, text] of files) zip.addBuffer(Buffer.from(text), path)
  zip.end()
  const chunks: Buffer[] = []
  for await (const chunk of zip.outputStream as Readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function createDiagram(url: string, title: string): Promise<DiagramSummary> {
  const response = await fetch(`${url}/api/diagrams`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  })
  expect(response.status).toBe(201)
  return await response.json() as DiagramSummary
}

async function download(url: string): Promise<{ response: Response; buffer: Buffer }> {
  const response = await fetch(`${url}/api/backup`)
  return { response, buffer: Buffer.from(await response.arrayBuffer()) }
}

it('exports diagrams and tracker trees and restores or replaces them by their stable identities', async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'decompose-backup-source-'))
  const targetDir = await mkdtemp(join(tmpdir(), 'decompose-backup-target-'))
  const source = createBackend({ dataDir: sourceDir, clientDir: resolve('dist/client') })
  const target = createBackend({ dataDir: targetDir, clientDir: resolve('dist/client') })
  try {
    const sourceUrl = `http://127.0.0.1:${await source.listen(0)}`
    const diagram = await createDiagram(sourceUrl, 'Одинаковое название допустимо')
    const trackerResponse = await fetch(`${sourceUrl}/api/tracker/BACKUP-42`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(trackerResponse.status).toBe(201)
    const tracker = await trackerResponse.json() as DiagramSummary & { trackerKey: string }

    const exported = await download(sourceUrl)
    expect(exported.response.status).toBe(200)
    expect(exported.response.headers.get('content-type')).toContain('application/zip')
    expect(exported.response.headers.get('content-disposition')).toMatch(/attachment; filename="decompose-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z\.zip"/)
    const entries = await zipEntries(exported.buffer)
    expect([...entries.keys()].sort()).toEqual([
      'diagram/', `diagram/${diagram.id}.deco`, 'manifest.json', 'tracker/', 'tracker/BACKUP-42.deco',
    ].sort())
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as BackupManifest
    expect(manifest).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION })
    expect(manifest.items).toEqual(expect.arrayContaining([
      { kind: 'diagram', id: diagram.id, path: `diagram/${diagram.id}.deco`, title: diagram.title },
      { kind: 'tracker', id: tracker.id, path: 'tracker/BACKUP-42.deco', title: 'BACKUP-42', trackerKey: 'BACKUP-42' },
    ]))
    expect(parseDiagramFile(entries.get(`diagram/${diagram.id}.deco`)!.toString('utf8')).nodes[0].text).toBe(diagram.title)

    const targetUrl = `http://127.0.0.1:${await target.listen(0)}`
    const restored = await fetch(`${targetUrl}/api/backup`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(exported.buffer),
    })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ loaded: 2, replaced: 0, failed: 0, failures: [], replacements: [] })
    expect(await (await fetch(`${targetUrl}/api/diagrams/${diagram.id}`)).json()).toEqual(diagram)
    expect(await (await fetch(`${targetUrl}/api/tracker/BACKUP-42`)).json()).toMatchObject({ id: tracker.id, trackerKey: 'BACKUP-42' })

    const repeated = await fetch(`${targetUrl}/api/backup`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(exported.buffer),
    })
    expect(repeated.status).toBe(200)
    const result = await repeated.json()
    expect(result).toMatchObject({ loaded: 2, replaced: 2, failed: 0, failures: [], failuresTruncated: false, replacementsTruncated: false })
    expect(result.replacements).toHaveLength(2)

    for (const id of [diagram.id, tracker.id]) {
      const generation = await (await fetch(`${targetUrl}/api/diagrams/${id}/generation`)).json() as { generation: number }
      const removed = await fetch(`${targetUrl}/api/diagrams/${id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generation: generation.generation, operation: randomUUID() }),
      })
      expect(removed.status).toBe(200)
    }
    const resurrected = await fetch(`${targetUrl}/api/backup`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(exported.buffer),
    })
    expect(await resurrected.json()).toMatchObject({ loaded: 2, replaced: 0, failed: 0 })
    expect(await (await fetch(`${targetUrl}/api/diagrams/${diagram.id}`)).json()).toEqual(diagram)
    expect(await (await fetch(`${targetUrl}/api/tracker/BACKUP-42`)).json()).toMatchObject({ id: tracker.id })
  } finally {
    await Promise.all([source.close(), target.close()])
    await Promise.all([rm(sourceDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })])
  }
}, 30000)

it('reports individual file failures, limits details and rejects an invalid archive before changing storage', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-backup-errors-'))
  const backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  try {
    const url = `http://127.0.0.1:${await backend.listen(0)}`
    const validId = randomUUID()
    const valid = { kind: 'diagram' as const, id: validId, path: `diagram/${validId}.deco`, title: 'Исправная схема' }
    const broken = Array.from({ length: 102 }, (_, index) => {
      const id = randomUUID()
      return { kind: 'diagram' as const, id, path: `diagram/${id}.deco`, title: `Повреждённая схема ${index + 1}` }
    })
    const items = [valid, ...broken]
    const manifest: BackupManifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: new Date().toISOString(), items }
    const files = new Map<string, string>([['manifest.json', JSON.stringify(manifest)]])
    files.set(valid.path, JSON.stringify({ format: 'decompose', version: 1,
      nodes: [{ id: 'root', text: valid.title, status: 'open', children: [] }], settings: { textAlign: 'center' } }))
    for (const item of broken) files.set(item.path, '{')
    const archive = await makeZip(files)
    const response = await fetch(`${url}/api/backup`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(archive),
    })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ loaded: 1, replaced: 0, failed: 102, failuresTruncated: true, replacementsTruncated: false })
    expect(result.failures).toHaveLength(100)
    expect(await (await fetch(`${url}/api/diagrams`)).json()).toEqual([{ id: valid.id, title: valid.title }])

    const extra = new Map(files)
    extra.set('unknown.txt', 'unexpected')
    const invalid = await fetch(`${url}/api/backup`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(await makeZip(extra)),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'В архиве есть неизвестная запись unknown.txt.' })
    expect(await (await fetch(`${url}/api/diagrams`)).json()).toEqual([{ id: valid.id, title: valid.title }])
  } finally {
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30000)

it('limits the list of replaced diagrams to one hundred entries', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-backup-replaced-'))
  const backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  try {
    const url = `http://127.0.0.1:${await backend.listen(0)}`
    await Promise.all(Array.from({ length: 101 }, (_, index) => createDiagram(url, `Схема ${index + 1}`)))
    const archive = (await download(url)).buffer
    const response = await fetch(`${url}/api/backup`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(archive),
    })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ loaded: 101, replaced: 101, failed: 0, replacementsTruncated: true })
    expect(result.replacements).toHaveLength(100)
  } finally {
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30000)
