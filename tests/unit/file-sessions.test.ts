import { createTestDiagram } from './helpers'
import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { createBackend } from '../../src/server/app'
import { createImportedDocument, getStructures, projectTree, ROOT_ID, TreeCommands } from '../../src/domain'
import { DatabaseSync } from 'node:sqlite'
import { FileRooms } from '../../src/server/file-rooms'
import { Replacements } from '../../src/server/replacement'
import { TrackerStorage } from '../../src/server/tracker-storage'

const file = { format: 'decompose', version: 1, nodes: [{ id: 'r', text: 'Восстановлено', status: 'done', children: [] }], settings: { textAlign: 'center' } }
const uuid = () => crypto.randomUUID()
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'decompose-files-'))
  let backend = createBackend({ dataDir: directory, clientDir: resolve('dist/client') })
  const port = await backend.listen(0), url = `http://127.0.0.1:${port}`
  const clients: { provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket }[] = []
  const connect = (name: string, options: { token?: string; doc?: Y.Doc; file?: boolean } = {}) => {
    const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/${options.file ? 'file-collaboration' : 'collaboration'}`, WebSocketPolyfill: WebSocket })
    const provider = new HocuspocusProvider({ websocketProvider: socket, name, token: options.token ?? '', document: options.doc })
    const messages: Record<string, unknown>[] = []
    let denied = false
    provider.on('stateless', ({ payload }: { payload: string }) => messages.push(JSON.parse(payload)))
    provider.on('authenticationFailed', () => { denied = true })
    provider.attach(); clients.push({ provider, socket })
    return { provider, socket, messages, denied: () => denied }
  }
  const post = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const publish = (state: string, id: string = uuid(), secret = uuid() + uuid()) => fetch(url + '/api/file-sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify({ id, state }),
  })
  return { get backend() { return backend }, directory, url, connect, post, publish,
    restart: async () => {
      await backend.close()
      backend = createBackend({ dataDir: directory, clientDir: resolve('dist/client') })
      await backend.listen(port)
    }, close: async () => {
    for (const { provider, socket } of clients) { provider.destroy(); socket.destroy(); provider.document.destroy() }
    await backend.close(); await rm(directory, { recursive: true, force: true })
  } }
}

it('rejects obsolete IDs, deletes a tracker tree permanently and requires explicit recreation with a new ID', async () => {
  const f = await fixture()
  const remove = (id: string, operation: string) => fetch(`${f.url}/api/diagrams/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: 0, operation }) })
  try {
    expect((await remove('main', uuid())).status).toBe(400)
    expect((await fetch(f.url + '/api/diagrams/main', { method: 'DELETE' })).status).toBe(400)
    const { id } = await (await f.post('/api/tracker/REMOVE-1', {})).json()
    const client = f.connect(id)
    client.provider.on('stateless', ({ payload }: { payload: string }) => {
      const message = JSON.parse(payload)
      if (message.type === 'replace-prepare') client.provider.sendStateless(JSON.stringify({ type: 'replace-ready', operation: message.operation }))
    })
    await expect.poll(() => client.provider.synced).toBe(true)
    const operation = uuid()
    expect((await remove(id, operation)).status).toBe(200)
    expect((await remove(id, operation)).status).toBe(200)
    expect((await fetch(`${f.url}/api/diagrams/${id}`)).status).toBe(410)
    expect((await fetch(`${f.url}/api/tracker/REMOVE-1`)).status).toBe(410)
    expect((await f.post('/api/tracker/REMOVE-1', {})).status).toBe(409)
    new TreeCommands(client.provider.document).setText(ROOT_ID, 'Не воскресить')
    client.socket.disconnect()
    const stale = f.connect(id); await expect.poll(stale.denied).toBe(true)
    const fresh = await (await f.post('/api/tracker/REMOVE-1', { recreateDeletedId: id })).json()
    expect(fresh.id).not.toBe(id)
    expect(fresh.title).toBe('REMOVE-1')
    expect((await (await f.post('/api/tracker/REMOVE-1', { recreateDeletedId: id })).json()).id).toBe(fresh.id)
    const db = new DatabaseSync(join(f.directory, 'decompose.sqlite'), { readOnly: true })
    try { expect(db.prepare('SELECT * FROM documents WHERE name = ?').get(id)).toBeUndefined() } finally { db.close() }
  } finally { await f.close() }
})

it('prepares a synchronized immutable transfer snapshot, excludes other operations and only deletes on commit', async () => {
  const f = await fixture()
  try {
    const { id } = await (await f.post('/api/diagrams/import', file)).json()
    const a = f.connect(id), b = f.connect(id)
    await expect.poll(() => a.provider.synced && b.provider.synced).toBe(true)
    const operation = uuid(), path = `/api/diagrams/${id}/file-transfer`
    const pending = f.post(path, { operation, generation: 0 })
    await expect.poll(() => a.messages.some(m => m.type === 'replace-prepare')).toBe(true)
    new TreeCommands(b.provider.document).setText(ROOT_ID, 'Последний draft')
    await expect.poll(() => b.provider.hasUnsyncedChanges).toBe(false)
    for (const c of [a, b]) c.provider.sendStateless(JSON.stringify({ type: 'replace-ready', operation }))
    const prepared = await (await pending).json()
    expect(prepared.file.nodes[0].text).toBe('Последний draft')
    expect(prepared.file.settings.textAlign).toBe('center')
    expect((await f.post(`/api/diagrams/${id}/replace`, { generation: 0, file })).status).toBe(409)
    expect((await fetch(`${f.url}/api/diagrams/${id}`)).status).toBe(200)
    new TreeCommands(b.provider.document).setText(ROOT_ID, 'После блокировки')
    expect((await (await f.post(path, { operation, generation: 0 })).json()).file).toEqual(prepared.file)
    expect((await f.post(`${path}/${operation}/commit`, {})).status).toBe(200)
    expect((await f.post(`${path}/${operation}/commit`, {})).status).toBe(200)
    expect((await fetch(`${f.url}/api/diagrams/${id}/generation`)).status).toBe(410)
  } finally { await f.close() }
})

it('aborts prepared transfers on participant disconnect, explicit cancellation and expiry without deleting', async () => {
  const f = await fixture()
  const storage = new TrackerStorage(join(f.directory, 'decompose.sqlite'))
  await storage.onConfigure()
  const coordinator = new Replacements(storage, f.backend.collaboration, 100, 30)
  try {
    const { id } = await (await f.post('/api/diagrams/import', file)).json()
    const path = `/api/diagrams/${id}/file-transfer`, operation = uuid()
    expect((await f.post(path, { generation: 0, operation })).status).toBe(200)
    await fetch(f.url + `${path}/${operation}`, { method: 'DELETE' })
    expect((await f.post(`${path}/${operation}/commit`, {})).status).toBe(409)
    const expired = uuid()
    await coordinator.prepareTransfer(id, 0, expired)
    await expect.poll(() => coordinator.locked(id)).toBe(false)
    expect(() => coordinator.commitTransfer(id, expired)).toThrow('отменён')
    const client = f.connect(id)
    await expect.poll(() => client.provider.synced).toBe(true)
    const disconnected = uuid(), prepared = f.post(path, { generation: 0, operation: disconnected })
    await expect.poll(() => client.messages.some(m => m.type === 'replace-prepare')).toBe(true)
    client.provider.sendStateless(JSON.stringify({ type: 'replace-ready', operation: disconnected }))
    expect((await prepared).status).toBe(200)
    client.socket.disconnect()
    await expect.poll(() => f.backend.collaboration.documents.get(id)?.getConnections().length ?? 0).toBe(0)
    expect((await f.post(`${path}/${disconnected}/commit`, {})).status).toBe(409)
    expect((await fetch(`${f.url}/api/diagrams/${id}`)).status).toBe(200)
  } finally { coordinator.close(); storage.db?.close(); await f.close() }
})

it('retains deletion and its idempotency result after a full restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decompose-delete-restart-'))
  let backend = createBackend({ dataDir: directory, clientDir: resolve('dist/client') })
  try {
    let url = `http://127.0.0.1:${await backend.listen(0)}`
    const { id } = await (await fetch(url + '/api/diagrams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Удалить' }) })).json()
    const operation = uuid(), body = JSON.stringify({ generation: 0, operation })
    expect((await fetch(`${url}/api/diagrams/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(200)
    await backend.close(); backend = createBackend({ dataDir: directory, clientDir: resolve('dist/client') })
    url = `http://127.0.0.1:${await backend.listen(0)}`
    expect((await fetch(`${url}/api/diagrams/${id}`)).status).toBe(410)
    expect((await fetch(`${url}/api/diagrams/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(200)
    await expect(backend.collaboration.openDirectConnection(id)).rejects.toThrow()
  } finally { await backend.close(); await rm(directory, { recursive: true, force: true }) }
})

it('replacement drains all clients, preserves the URL and tracker binding, and rejects stale generations and stores', async () => {
  const f = await fixture()
  try {
    const { id } = await (await f.post('/api/tracker/FILES-1', {})).json()
    const a = f.connect(id), b = f.connect(id)
    await expect.poll(() => a.provider.synced && b.provider.synced).toBe(true)
    const replacement = f.post(`/api/diagrams/${id}/replace`, { generation: 0, file })
    await expect.poll(() => a.messages.some(m => m.type === 'replace-prepare') && b.messages.some(m => m.type === 'replace-prepare')).toBe(true)
    expect((await f.post(`/api/diagrams/${id}/replace`, { generation: 0, file })).status).toBe(409)
    new TreeCommands(b.provider.document).setText(ROOT_ID, 'Завершённый draft')
    await expect.poll(() => b.provider.hasUnsyncedChanges).toBe(false)
    for (const client of [a, b]) {
      const operation = client.messages.find(m => m.type === 'replace-prepare')!.operation
      client.provider.sendStateless(JSON.stringify({ type: 'replace-ready', operation }))
    }
    expect((await replacement).status).toBe(200)
    expect(await (await fetch(f.url + `/api/diagrams/${id}/generation`)).json()).toEqual({ generation: 1 })
    new TreeCommands(a.provider.document).setText(ROOT_ID, 'Запоздалое изменение')
    const fresh = f.connect(`${id}~1`)
    await expect.poll(() => fresh.provider.synced).toBe(true)
    expect(projectTree(fresh.provider.document).nodes.get(ROOT_ID)?.text).toBe('Восстановлено')
    expect(getStructures(fresh.provider.document).settings.get('textAlign')).toBe('center')
    const old = f.connect(id); await expect.poll(old.denied).toBe(true)
    expect((await (await fetch(f.url + '/api/tracker/FILES-1')).json()).id).toBe(id)
    expect((await (await fetch(f.url + `/api/diagrams/${id}`)).json()).title).toBe('Восстановлено')
    a.socket.disconnect(); b.socket.disconnect()
    const db = new DatabaseSync(join(f.directory, 'decompose.sqlite'), { readOnly: true })
    try {
      expect(db.prepare('SELECT generation FROM document_generations WHERE name = ?').get(id)).toEqual({ generation: 1 })
      const saved = new Y.Doc()
      Y.applyUpdate(saved, (db.prepare('SELECT data FROM documents WHERE name = ?').get(id) as { data: Buffer }).data)
      expect(projectTree(saved).nodes.get(ROOT_ID)?.text).toBe('Восстановлено'); saved.destroy()
    } finally { db.close() }
  } finally { await f.close() }
}, 15000)

it('times out an unresponsive participant without replacing the document', async () => {
  const f = await fixture()
  try {
    const id = await createTestDiagram(f.url)
    const client = f.connect(id)
    await expect.poll(() => client.provider.synced).toBe(true)
    const pending = f.post(`/api/diagrams/${id}/replace`, { generation: 0, file })
    await expect.poll(() => client.messages.some(m => m.type === 'replace-prepare')).toBe(true)
    const late = f.connect(id); await expect.poll(late.denied).toBe(true)
    expect((await pending).status).toBe(409)
    expect(await (await fetch(f.url + `/api/diagrams/${id}/generation`)).json()).toEqual({ generation: 0 })
    new TreeCommands(client.provider.document).setText(ROOT_ID, 'После тайм-аута')
    await expect.poll(() => client.provider.hasUnsyncedChanges).toBe(false)
  } finally { await f.close() }
}, 25000)

it('expires an unopened memory room and never recreates it implicitly', async () => {
  const rooms = new FileRooms(20), doc = createImportedDocument(file)
  try {
    const id = uuid()
    expect(rooms.create(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), id, `Bearer ${uuid() + uuid()}`).status).toBe(201)
    expect(rooms.rooms.has(id)).toBe(true)
    await expect.poll(() => rooms.rooms.has(id)).toBe(false)
  } finally { doc.destroy(); await rooms.close() }
})

it('restarts after replacing a diagram and restores its generation and snapshot from SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decompose-generation-restart-'))
  let backend = createBackend({ dataDir: directory, clientDir: resolve('dist/client') })
  try {
    let url = `http://127.0.0.1:${await backend.listen(0)}`
    const id = await createTestDiagram(url)
    const response = await fetch(url + `/api/diagrams/${id}/replace`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: 0, file }),
    })
    expect(response.status).toBe(200)
    await backend.close()
    backend = createBackend({ dataDir: directory, clientDir: resolve('dist/client') })
    url = `http://127.0.0.1:${await backend.listen(0)}`
    expect(await (await fetch(url + `/api/diagrams/${id}/generation`)).json()).toEqual({ generation: 1 })
    expect((await (await fetch(url + `/api/diagrams/${id}`)).json()).title).toBe('Восстановлено')
    const direct = await backend.collaboration.openDirectConnection(`${id}~1`)
    expect(getStructures(direct.document!).settings.get('textAlign')).toBe('center')
    await direct.disconnect()
  } finally { await backend.close(); await rm(directory, { recursive: true, force: true }) }
})

it('aborts replacement when a participant disconnects and releases the surviving client', async () => {
  const f = await fixture()
  try {
    const id = await createTestDiagram(f.url)
    const a = f.connect(id), b = f.connect(id)
    await expect.poll(() => a.provider.synced && b.provider.synced).toBe(true)
    const pending = f.post(`/api/diagrams/${id}/replace`, { generation: 0, file })
    await expect.poll(() => a.messages.some(m => m.type === 'replace-prepare')).toBe(true)
    a.provider.sendStateless(JSON.stringify({ type: 'replace-ready', operation: a.messages[0].operation }))
    b.socket.disconnect()
    expect((await pending).status).toBe(409)
    await expect.poll(() => a.messages.some(m => m.type === 'replace-cancelled')).toBe(true)
    new TreeCommands(a.provider.document).setText(ROOT_ID, 'Можно продолжать')
    await expect.poll(() => a.provider.hasUnsyncedChanges).toBe(false)
    expect((await (await fetch(f.url + `/api/diagrams/${id}`)).json()).title).toBe('Можно продолжать')
  } finally { await f.close() }
}, 15000)

it('registers the file ID, retries without replacing CRDT and refuses ID takeover', async () => {
  const f = await fixture(), doc = createImportedDocument(file)
  try {
    const id = uuid(), secret = uuid() + uuid(), state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
    for (const invalid of ['', 'main', 'invalid', `${id}~${uuid()}`]) expect((await f.publish(state, invalid, secret)).status).toBe(400)
    expect((await f.publish(state, id, 'guessable')).status).toBe(400)
    expect((await f.post('/api/file-sessions', { id, state })).status).toBe(400)
    expect((await f.publish('broken', id, secret)).status).toBe(400)
    expect((await fetch(`${f.url}/api/file-sessions/${id}`)).status).toBe(404)
    const first = await f.publish(state, id, secret)
    expect(first.status).toBe(201)
    const registration = await first.json()
    expect(registration.id).toBe(id)
    const original = f.backend.fileRooms.rooms.get(id)
    expect((await f.publish(state, id, uuid() + uuid())).status).toBe(409)
    new TreeCommands(doc).setText(ROOT_ID, 'Не заменяет существующую комнату')
    const retry = await f.publish(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), id, secret)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(registration)
    expect(f.backend.fileRooms.rooms.get(id)).toBe(original)
    expect(original?.saved).not.toContain('Не заменяет')
    const owner = f.connect(registration.name, { file: true, token: secret })
    await expect.poll(() => owner.provider.synced).toBe(true)
    expect((await f.publish(state, id, secret)).status).toBe(409)
    owner.socket.disconnect()
    await f.restart()
    expect((await f.publish(state, id, uuid() + uuid())).status).toBe(409)
    const restored = await f.publish(state, id, secret)
    expect(restored.status).toBe(201)
    const current = await restored.json()
    expect(current.id).toBe(id)
    expect(current.name).not.toBe(registration.name)
    expect(await (await f.publish(state, id, secret)).json()).toEqual(current)
  } finally { doc.destroy(); await f.close() }
})

it('resumes the latest CRDT only with the owner secret and refuses a second writer', async () => {
  const f = await fixture()
  try {
    const doc = createImportedDocument(file)
    const { id, secret } = await (await f.publish(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'))).json()
    const path = `${f.url}/api/file-sessions/${id}/resume`
    expect((await fetch(path)).status).toBe(404)
    expect((await fetch(path, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(404)
    const owner = f.connect(id, { file: true, token: secret, doc })
    await expect.poll(() => owner.provider.synced).toBe(true)
    const second = f.connect(id, { file: true, token: secret })
    await expect.poll(second.denied).toBe(true)
    expect((await fetch(path, { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(409)
    new TreeCommands(doc).setText(ROOT_ID, 'Последняя сохранённая версия')
    await expect.poll(() => owner.provider.hasUnsyncedChanges).toBe(false)
    owner.provider.sendStateless(JSON.stringify({ type: 'file-saved', revision: f.backend.fileRooms.rooms.get(id)!.revision }))
    await expect.poll(() => f.backend.fileRooms.rooms.get(id)?.saved).toContain('Последняя сохранённая версия')
    owner.socket.disconnect()
    await expect.poll(() => f.backend.fileRooms.rooms.get(id)?.ownerSocket).toBeUndefined()
    const response = await fetch(path, { headers: { Authorization: `Bearer ${secret}` } })
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    const data = await response.json(), restored = new Y.Doc()
    try {
      Y.applyUpdate(restored, Buffer.from(data.state, 'base64'))
      expect(projectTree(restored).nodes.get(ROOT_ID)?.text).toBe('Последняя сохранённая версия')
      expect(data.saved).toContain('Последняя сохранённая версия')
    } finally { restored.destroy() }
    expect(f.backend.fileRooms.rooms.get(id)?.timer).toBeDefined()
  } finally { await f.close() }
})

it('file collaboration is memory-only, pauses without the owner and cannot be resumed by a guest', async () => {
  const f = await fixture()
  try {
    const doc = createImportedDocument(file)
    const { id, secret } = await (await f.publish(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'))).json()
    const owner = f.connect(id, { file: true, token: secret, doc })
    const guest = f.connect(id, { file: true })
    await expect.poll(() => owner.provider.synced && guest.provider.synced).toBe(true)
    owner.provider.sendStateless(JSON.stringify({ type: 'file-saved', revision: f.backend.fileRooms.rooms.get(id)!.revision }))
    await expect.poll(() => f.backend.fileRooms.rooms.get(id)?.active).toBe(true)
    new TreeCommands(guest.provider.document).setText(ROOT_ID, 'Только в оперативной памяти')
    await expect.poll(() => projectTree(owner.provider.document).nodes.get(ROOT_ID)?.text).toBe('Только в оперативной памяти')
    expect((await (await fetch(f.url + '/api/diagrams')).json()).map((item: { id: string }) => item.id)).toEqual([])
    expect((await fetch(f.url + `/api/diagrams/${id}`)).status).toBe(404)
    owner.socket.disconnect()
    await expect.poll(() => f.backend.fileRooms.rooms.get(id)?.active).toBe(false)
    guest.provider.sendStateless(JSON.stringify({ type: 'file-saved', revision: f.backend.fileRooms.rooms.get(id)!.revision }))
    new TreeCommands(guest.provider.document).setText(ROOT_ID, 'Запрещённая правка')
    await expect.poll(() => guest.messages.some(m => m.type === 'file-paused')).toBe(true)
    expect(projectTree(f.backend.fileRooms.transport.hocuspocus.documents.get(id)!).nodes.get(ROOT_ID)?.text).toBe('Только в оперативной памяти')
    expect(f.backend.fileRooms.rooms.get(id)?.active).toBe(false)
    guest.socket.disconnect()
    await expect.poll(() => f.backend.fileRooms.transport.hocuspocus.documents.get(id)?.getConnectionsCount() ?? 0).toBe(0)
    expect(f.backend.fileRooms.rooms.has(id)).toBe(true)
    const restored = f.connect(id, { file: true, token: secret })
    await expect.poll(() => restored.provider.synced).toBe(true)
    expect(projectTree(restored.provider.document).nodes.get(ROOT_ID)?.text).toBe('Только в оперативной памяти')
    restored.provider.sendStateless(JSON.stringify({ type: 'file-close' }))
    await expect.poll(() => f.backend.fileRooms.rooms.has(id)).toBe(false)
  } finally { await f.close() }
}, 15000)

it('shares only the owner filename, retains it while paused and forgets it on restart', async () => {
  const f = await fixture()
  try {
    const doc = createImportedDocument(file), fileName = 'План «релиз» <1>.decompose.json'
    const { id, secret, name } = await (await f.publish(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'))).json()
    const owner = f.connect(name, { file: true, token: secret, doc }), guest = f.connect(name, { file: true })
    await expect.poll(() => owner.provider.synced && guest.provider.synced).toBe(true)
    const saved = (value: unknown) => owner.provider.sendStateless(JSON.stringify({ type: 'file-saved', revision: f.backend.fileRooms.rooms.get(id)!.revision, fileName: value }))
    saved(fileName)
    await expect.poll(() => guest.messages.at(-1)?.fileName).toBe(fileName)
    expect(await (await fetch(`${f.url}/api/file-sessions/${id}`)).json()).toEqual({ name, fileName })
    guest.provider.sendStateless(JSON.stringify({ type: 'file-saved', revision: f.backend.fileRooms.rooms.get(id)!.revision, fileName: 'Подмена.json' }))
    new TreeCommands(guest.provider.document).setText(ROOT_ID, 'После попытки подмены')
    await expect.poll(() => projectTree(doc).nodes.get(ROOT_ID)?.text).toBe('После попытки подмены')
    expect(f.backend.fileRooms.rooms.get(id)?.fileName).toBe(fileName)
    for (const invalid of ['/private/plan.json', 'C:\\private\\plan.json', 'line\nbreak', '', 'x'.repeat(1025), 123]) {
      const count = owner.messages.length
      saved(invalid)
      await expect.poll(() => owner.messages.length).toBeGreaterThan(count)
      expect(f.backend.fileRooms.rooms.get(id)?.fileName).toBe(fileName)
    }
    owner.socket.disconnect()
    await expect.poll(() => f.backend.fileRooms.rooms.get(id)?.ownerSocket).toBeUndefined()
    expect(await (await fetch(`${f.url}/api/file-sessions/${id}`)).json()).toEqual({ name: null, fileName })
    await f.restart()
    expect(await (await fetch(`${f.url}/api/file-sessions/${id}`)).json()).toEqual({ name: null })
  } finally { await f.close() }
})

it('retains the public file ID across a server restart, stores metadata only and rejects stale generations', async () => {
  const f = await fixture()
  try {
    const doc = createImportedDocument(file)
    const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
    const { id, secret, name } = await (await f.publish(state)).json()
    const path = `/api/file-sessions/${id}`
    const owner = f.connect(name, { file: true, token: secret, doc })
    await expect.poll(() => owner.provider.synced).toBe(true)
    owner.socket.disconnect()
    await f.restart()
    expect(await (await fetch(f.url + path)).json()).toEqual({ name: null })
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }
    expect((await fetch(f.url + path + '/resume', { headers })).status).toBe(410)
    expect((await f.post(path + '/restore', { state })).status).toBe(404)
    expect((await fetch(f.url + path + '/restore', { method: 'POST', headers: { ...headers, Authorization: 'Bearer wrong' }, body: JSON.stringify({ state }) })).status).toBe(404)
    expect((await fetch(f.url + path + '/restore', { method: 'POST', headers, body: JSON.stringify({ state: 'broken' }) })).status).toBe(400)
    const restored = await fetch(f.url + path + '/restore', { method: 'POST', headers, body: JSON.stringify({ state }) })
    expect(restored.status).toBe(200)
    const current = await restored.json()
    expect(current.id).toBe(id); expect(current.name).not.toBe(name)
    expect((await fetch(f.url + path + '/restore', { method: 'POST', headers, body: JSON.stringify({ state }) })).status).toBe(409)
    new TreeCommands(doc).setText(ROOT_ID, 'Устаревшая правка не должна попасть в файл')
    const stale = f.connect(name, { file: true, doc }), staleOwner = f.connect(name, { file: true, token: secret })
    await expect.poll(() => stale.denied() && staleOwner.denied()).toBe(true)
    const fresh = f.connect(current.name, { file: true, token: secret })
    await expect.poll(() => fresh.provider.synced).toBe(true)
    expect((await fetch(f.url + path + '/restore', { method: 'POST', headers, body: JSON.stringify({ state, replace: true }) })).status).toBe(409)
    expect(projectTree(fresh.provider.document).nodes.get(ROOT_ID)?.text).toBe('Восстановлено')
    expect(await (await fetch(f.url + path)).json()).toEqual({ name: null })
    fresh.provider.sendStateless(JSON.stringify({ type: 'file-saved', revision: f.backend.fileRooms.rooms.get(id)!.revision }))
    await expect.poll(() => f.backend.fileRooms.rooms.get(id)?.active).toBe(true)
    expect(await (await fetch(f.url + path)).json()).toEqual({ name: current.name })
    const guest = f.connect(current.name, { file: true })
    await expect.poll(() => guest.provider.synced).toBe(true)
    expect(projectTree(guest.provider.document).nodes.get(ROOT_ID)?.text).toBe('Восстановлено')
    fresh.socket.disconnect()
    await expect.poll(() => f.backend.fileRooms.rooms.get(id)?.ownerSocket).toBeUndefined()
    expect((await fetch(f.url + path + '/restore', { method: 'POST', headers, body: JSON.stringify({ state: 'broken', replace: true }) })).status).toBe(400)
    expect(f.backend.fileRooms.rooms.get(id)?.name).toBe(current.name)
    const replaced = await fetch(f.url + path + '/restore', { method: 'POST', headers, body: JSON.stringify({ state, replace: true }) })
    expect(replaced.status).toBe(200)
    expect((await replaced.json()).name).not.toBe(current.name)
    await expect.poll(() => guest.messages.some(message => message.type === 'file-ended')).toBe(true)
    const db = new DatabaseSync(join(f.directory, 'decompose.sqlite'), { readOnly: true })
    try {
      const metadata = db.prepare('SELECT * FROM file_sessions WHERE id = ?').get(id)!
      expect(Object.keys(metadata).sort()).toEqual(['id', 'secret_hash'])
      expect(metadata.secret_hash).toMatch(/^[a-f0-9]{64}$/)
      expect(metadata.secret_hash).not.toBe(secret)
      expect(db.prepare('SELECT * FROM documents WHERE name = ?').get(id)).toBeUndefined()
    } finally { db.close() }
  } finally { await f.close() }
}, 15000)
