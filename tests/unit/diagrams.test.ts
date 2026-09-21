import { createTestDiagram } from './helpers'
import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { createBackend } from '../../src/server/app'
import { getStructures, projectTree, readTextAlign, ROOT_ID, TreeCommands } from '../../src/domain'
import { isDiagramId, type DiagramSummary } from '../../src/shared/diagrams'

it('creates isolated durable diagrams, lists live root titles and preserves independent documents across restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-diagrams-'))
  let backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  try {
    let port = await backend.listen(0)
    let url = `http://127.0.0.1:${port}`
    const legacyId = await createTestDiagram(url)
    const legacy = await backend.collaboration.openDirectConnection(legacyId)
    const legacyChild = new TreeCommands(legacy.document!).createChild(ROOT_ID, 'Прежние данные')
    await legacy.disconnect()
    for (const body of [{}, { title: '' }, { title: '   ' }, { title: 12 }, { title: 'я'.repeat(501) }]) {
      expect((await fetch(`${url}/api/diagrams`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(400)
    }
    expect((await fetch(`${url}/api/diagrams`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400)
    const created = await Promise.all([1, 2].map(async () => {
      const response = await fetch(`${url}/api/diagrams`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '  Одинаковое название\nсхемы  ' }) })
      expect(response.status).toBe(201)
      return await response.json() as DiagramSummary
    }))
    expect(created[0].id).not.toBe(created[1].id)
    expect(created.every(item => isDiagramId(item.id))).toBe(true)
    expect(created[0].title).toBe('Одинаковое название схемы')
    const first = await backend.collaboration.openDirectConnection(created[0].id)
    const second = await backend.collaboration.openDirectConnection(created[1].id)
    expect(readTextAlign(first.document!)).toBe('center')
    expect(readTextAlign(second.document!)).toBe('center')
    expect(projectTree(first.document!).nodes.size).toBe(1)
    expect(projectTree(second.document!).nodes.size).toBe(1)
    await first.transact(doc => { getStructures(doc).nodes.get(ROOT_ID)!.set('text', 'Переименовано через корень') })
    const child = new TreeCommands(first.document!).createChild(ROOT_ID, 'Только первая схема')
    const list = await (await fetch(`${url}/api/diagrams`)).json() as DiagramSummary[]
    expect(list).toHaveLength(3)
    expect(list.find(item => item.id === created[0].id)?.title).toBe('Переименовано через корень')
    expect(projectTree(second.document!).nodes.has(child)).toBe(false)
    expect((await fetch(`${url}/api/diagrams/${randomUUID()}`)).status).toBe(404)
    expect((await fetch(`${url}/api/diagrams/not-a-diagram`)).status).toBe(404)
    await first.disconnect()
    await second.disconnect()
    await backend.close()
    backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
    port = await backend.listen(0)
    url = `http://127.0.0.1:${port}`
    expect(await (await fetch(`${url}/api/diagrams/${created[0].id}`)).json()).toEqual({ id: created[0].id, title: 'Переименовано через корень' })
    const restored = await backend.collaboration.openDirectConnection(created[0].id)
    expect(projectTree(restored.document!).nodes.get(child)?.text).toBe('Только первая схема')
    await restored.disconnect()
    const main = await backend.collaboration.openDirectConnection(legacyId)
    expect(projectTree(main.document!).nodes.get(legacyChild)?.text).toBe('Прежние данные')
    expect(projectTree(main.document!).nodes.has(child)).toBe(false)
    await main.disconnect()
  } finally {
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30000)

it('rejects unknown WebSocket document names without implicitly creating a diagram', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-unknown-diagram-'))
  const backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  try {
    const port = await backend.listen(0)
    for (const name of [randomUUID(), 'unknown', 'main', 'main~1']) {
      const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collaboration`, WebSocketPolyfill: WebSocket })
      let reason = ''
      const provider = new HocuspocusProvider({ websocketProvider: socket, name, onAuthenticationFailed: event => { reason = event.reason } })
      provider.attach()
      try { await expect.poll(() => reason, { timeout: 5000 }).toBe('permission-denied') }
      finally { provider.destroy(); socket.destroy(); provider.document.destroy() }
    }
    const list = await (await fetch(`http://127.0.0.1:${port}/api/diagrams`)).json()
    expect(list).toEqual([])
  } finally {
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30000)

it('removes awareness immediately when a reconnected client leaves without sending a farewell', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-presence-'))
  const backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  let socket: HocuspocusProviderWebsocket | undefined
  let provider: HocuspocusProvider | undefined
  try {
    const port = await backend.listen(0)
    const id = await createTestDiagram(`http://127.0.0.1:${port}`)
    socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collaboration`, WebSocketPolyfill: WebSocket })
    provider = new HocuspocusProvider({ websocketProvider: socket, name: id })
    provider.attach()
    const clientId = provider.document.clientID
    provider.setAwarenessField('user', { id: 'stable-browser-id', name: 'Анна' })
    await expect.poll(() => backend.collaboration.documents.get(id)?.awareness.getStates().has(clientId), { timeout: 5000 }).toBe(true)
    // Удерживаем уже загруженный сокетом документ, чтобы между reconnect не сбрасывалась Awareness metadata.
    const witness = await backend.collaboration.openDirectConnection(id)
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        await expect.poll(() => witness.document!.awareness.getStates().has(clientId), { timeout: 5000 }).toBe(true)
        socket.disconnect()
        await expect.poll(() => witness.document!.awareness.getStates().has(clientId), { timeout: 2000 }).toBe(false)
        if (cycle < 2) {
          provider.setAwarenessField('user', { id: 'stable-browser-id', name: `Анна ${cycle}` })
          await socket.connect()
        }
      }
    } finally { await witness.disconnect() }
  } finally {
    provider?.destroy()
    socket?.destroy()
    provider?.document.destroy()
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 15000)
