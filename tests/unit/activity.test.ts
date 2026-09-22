import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { removeAwarenessStates } from 'y-protocols/awareness'
import { createBackend } from '../../src/server/app'
import { getStructures, initializeDocument, ROOT_ID, TreeCommands } from '../../src/domain'
import { isActivitySnapshot, type ActivitySnapshot } from '../../src/shared/activity'
import { isParticipantRoster, type ParticipantRoster } from '../../src/shared/participant-roster'
import { createTestDiagram } from './helpers'

interface Client { provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket; messages: unknown[] }

it('reports live diagram, tracker, file and monitoring connections without persisting or joining user documents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decompose-activity-'))
  const backend = createBackend({ dataDir: directory, clientDir: resolve('dist/client') })
  const clients: Client[] = []
  let latest: ActivitySnapshot | null = null
  try {
    const port = await backend.listen(0)
    const url = `http://127.0.0.1:${port}`
    const connect = (endpoint: string, name: string, user: { id: string; name: string | null }, token = '') => {
      const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/${endpoint}`, WebSocketPolyfill: WebSocket })
      const provider = new HocuspocusProvider({ websocketProvider: socket, name, token })
      const messages: unknown[] = []
      provider.on('stateless', ({ payload }: { payload: string }) => {
        const value: unknown = JSON.parse(payload)
        messages.push(value)
        if (isActivitySnapshot(value)) latest = value
      })
      provider.attach()
      provider.setAwarenessField('user', user)
      const client = { provider, socket, messages }
      clients.push(client)
      return client
    }
    const closeClient = ({ provider, socket }: Client) => {
      provider.destroy(); socket.destroy(); provider.document.destroy()
      const index = clients.findIndex(client => client.provider === provider)
      if (index >= 0) clients.splice(index, 1)
    }

    const diagramId = await createTestDiagram(url, 'Рабочая схема')
    const first = connect('collaboration', diagramId, { id: 'same-profile', name: 'Анна' })
    const second = connect('collaboration', diagramId, { id: 'same-profile', name: 'Анна' })
    const tracker = await (await fetch(`${url}/api/tracker/ACT-42`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).json() as { id: string }
    connect('collaboration', tracker.id, { id: 'guest-profile', name: null })
    const closedId = await createTestDiagram(url, 'Закрытая схема')

    const fileId = randomUUID(), secret = randomUUID() + randomUUID()
    const fileDoc = new Y.Doc()
    initializeDocument(fileDoc, 'center')
    getStructures(fileDoc).nodes.get(ROOT_ID)!.set('text', 'Схема из файла')
    const state = Buffer.from(Y.encodeStateAsUpdate(fileDoc)).toString('base64')
    fileDoc.destroy()
    const published = await fetch(`${url}/api/file-sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ id: fileId, state }),
    })
    const room = await published.json() as { name: string }
    const owner = connect('file-collaboration', room.name, { id: 'owner', name: 'Ольга' }, secret)
    const fileGuest = connect('file-collaboration', room.name, { id: 'file-guest', name: 'Борис' })
    await expect.poll(() => owner.provider.synced, { timeout: 5000 }).toBe(true)
    await expect.poll(() => owner.messages.filter(isParticipantRoster).at(-1)).toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({ userId: 'owner', name: 'Ольга' }),
        expect.objectContaining({ userId: 'file-guest', name: 'Борис' }),
      ]),
    })
    owner.provider.sendStateless(JSON.stringify({ type: 'file-saved', revision: 0, fileName: 'Команда.deco' }))

    expect(backend.activity.transport.hocuspocus.documents.has('activity')).toBe(false)
    expect(backend.collaboration.documents.has(closedId)).toBe(false)
    const trackerBefore = await (await fetch(`${url}/api/tracker/ACT-42`)).json() as { updatedAt: number }
    const monitor = connect('activity-collaboration', 'activity', { id: 'monitor', name: 'Наблюдатель' })
    await expect.poll(() => latest?.connections.length ?? 0, { timeout: 5000 }).toBe(6)
    expect(backend.collaboration.documents.get(diagramId)?.getConnectionsCount()).toBe(2)

    const connections = latest!.connections
    const diagram = connections.filter(item => item.mode === 'diagram')
    expect(diagram).toHaveLength(2)
    expect(diagram.map(item => item.name)).toEqual(['Анна', 'Анна'])
    expect(diagram[0].resource).toMatchObject({ id: diagramId, label: 'Рабочая схема', route: `diagram/${diagramId}` })
    expect(connections.find(item => item.mode === 'tracker')).toMatchObject({
      name: null, resource: { id: tracker.id, label: 'ACT-42', route: 'tracker/ACT-42' },
    })
    expect(connections.filter(item => item.mode === 'file')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Ольга', owner: true, resource: expect.objectContaining({ label: 'Команда.deco', route: `file/session/${fileId}` }) }),
      expect.objectContaining({ name: 'Борис', owner: false, resource: expect.objectContaining({ label: 'Команда.deco', route: `file/session/${fileId}` }) }),
    ]))
    expect(connections.find(item => item.mode === 'activity')).toMatchObject({ name: 'Наблюдатель' })
    expect(connections.some(item => item.resource?.id === closedId)).toBe(false)

    const fileDocument = backend.fileRooms.transport.hocuspocus.documents.get(room.name)!
    removeAwarenessStates(fileDocument.awareness, [fileGuest.provider.document.clientID], null)
    latest = null
    monitor.provider.sendStateless(JSON.stringify({ type: 'activity-request' }))
    await expect.poll(() => latest?.connections.find(item => item.mode === 'file' && item.name === 'Борис')?.name, { timeout: 3000 })
      .toBe('Борис')
    await new Promise(resolve => setTimeout(resolve, 600))
    const trackerAfter = await (await fetch(`${url}/api/tracker/ACT-42`)).json() as { updatedAt: number }
    expect(trackerAfter.updatedAt).toBe(trackerBefore.updatedAt)

    new TreeCommands(first.provider.document).setText(ROOT_ID, 'Переименованная схема')
    first.provider.setAwarenessField('user', { id: 'same-profile', name: 'Анна Мария' })
    await expect.poll(() => latest?.connections.filter(item => item.mode === 'diagram').map(item => item.name), { timeout: 3000 })
      .toContain('Анна Мария')
    await expect.poll(() => latest?.connections.find(item => item.mode === 'diagram')?.resource?.label, { timeout: 3000 })
      .toBe('Переименованная схема')

    closeClient(second)
    await expect.poll(() => latest?.connections.filter(item => item.mode === 'diagram').length, { timeout: 3000 }).toBe(1)

    const diagramDocument = backend.collaboration.documents.get(diagramId)!
    removeAwarenessStates(diagramDocument.awareness, [first.provider.document.clientID], null)
    expect(diagramDocument.awareness.getStates().has(first.provider.document.clientID)).toBe(false)
    latest = null
    monitor.provider.sendStateless(JSON.stringify({ type: 'activity-request' }))
    await expect.poll(() => latest?.connections.find(item => item.mode === 'diagram')?.name, { timeout: 3000 }).toBe('Анна Мария')

    const observer = connect('collaboration', diagramId, { id: 'observer-profile', name: null })
    await expect.poll(() => observer.provider.synced).toBe(true)
    const latestRoster = () => observer.messages.filter(isParticipantRoster).at(-1) as ParticipantRoster | undefined
    await expect.poll(() => latestRoster()?.participants.some(item => item.userId === 'same-profile' && item.name === 'Анна Мария'))
      .toBe(true)
    expect(observer.provider.awareness?.getStates().has(first.provider.document.clientID)).toBe(false)
    closeClient(first)
    await expect.poll(() => latestRoster()?.participants.some(item => item.userId === 'same-profile')).toBe(false)

    const activityDocument = backend.activity.transport.hocuspocus.documents.get('activity')!
    removeAwarenessStates(activityDocument.awareness, [monitor.provider.document.clientID], null)
    latest = null
    monitor.provider.sendStateless(JSON.stringify({ type: 'activity-request' }))
    await expect.poll(() => latest?.connections.find(item => item.mode === 'activity')?.name, { timeout: 3000 }).toBe('Наблюдатель')

    const database = new DatabaseSync(join(directory, 'decompose.sqlite'), { readOnly: true })
    try { expect(database.prepare('SELECT 1 FROM documents WHERE name = ?').get('activity')).toBeUndefined() }
    finally { database.close() }
    expect(backend.activity.transport.hocuspocus.documents.get('activity')?.getConnectionsCount()).toBe(1)
    expect(monitor.provider.synced).toBe(true)
  } finally {
    for (const { provider, socket } of clients) { provider.destroy(); socket.destroy(); provider.document.destroy() }
    await backend.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
