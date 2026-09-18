import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBackend } from '../../src/server/app'
import { projectTree, ROOT_ID, TreeCommands } from '../../src/domain'
import { normalizeTrackerKey, trackerLabel, trackerSearch, type TrackerPage, type TrackerSummary } from '../../src/shared/tracker'
import { parseDiagramRoute } from '../../src/shared/diagram-route'

it('normalizes tracker keys and routes without treating malformed paths as main', () => {
  expect(normalizeTrackerKey('mc-99636')).toBe('MC-99636')
  expect(normalizeTrackerKey('P2-001')).toBe('P2-001')
  for (const value of ['', 'MC', 'MC-', 'MC-12/1', ' МС-1', 'МС-1', '1MC-1', 'MC--1', 'MC-1?', 'A'.repeat(100) + '-1', null]) {
    expect(normalizeTrackerKey(value)).toBeNull()
  }
  expect(parseDiagramRoute(new URL('http://localhost/tracker/mc-99636?diagram=main'))).toEqual({ kind: 'tracker', key: 'MC-99636' })
  expect(parseDiagramRoute(new URL('http://localhost/'))).toEqual({ kind: 'diagram', id: 'main' })
  for (const path of ['/tracker/', '/tracker/A-1/extra', '/tracker/A%2F-1', '/tracker/%XX', '/unknown']) {
    expect(() => parseDiagramRoute(new URL(path, 'http://localhost'))).toThrow()
  }
  expect(trackerSearch('  ЁЖ\nИ ЗАДАЧА  ')).toBe('ёж и задача')
  expect(trackerLabel('Описание', 'MC-1')).toBe('MC-1 · Описание')
  expect(trackerLabel('MC-1', 'MC-1')).toBe('MC-1')
  expect(trackerLabel('', 'MC-1')).toBe('MC-1')
})

it('creates exactly one durable tracker document and derives its title from the root', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-tracker-'))
  let backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  try {
    let url = `http://127.0.0.1:${await backend.listen(0)}`
    const get = async (path: string) => (await fetch(url + path)).json()
    expect((await fetch(url + '/api/tracker/MC-99636')).status).toBe(404)
    for (const key of ['bad', 'MC--1', '1MC-1', 'A'.repeat(100) + '-1']) {
      expect((await fetch(`${url}/api/tracker/${key}`, { method: 'POST' })).status).toBe(400)
    }
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => fetch(`${url}/api/tracker/${index % 2 ? 'MC-99636' : 'mc-99636'}`, { method: 'POST' })))
    expect(responses.filter(response => response.status === 201)).toHaveLength(1)
    const items = await Promise.all(responses.map(response => response.json() as Promise<TrackerSummary>))
    expect(new Set(items.map(item => item.id)).size).toBe(1)
    const task = items[0]
    expect(task.title).toBe('MC-99636')
    expect(await get('/api/diagrams')).toEqual([{ id: 'main', title: 'Новая декомпозиция' }])
    const live = await backend.collaboration.openDirectConnection(task.id)
    expect(projectTree(live.document!).nodes.get(ROOT_ID)?.text).toBe('MC-99636')
    const commands = new TreeCommands(live.document!)
    commands.setText(ROOT_ID, '  Починить\nотчёт Ёж  ')
    const child = commands.createChild(ROOT_ID, 'Деталь')
    await live.disconnect()
    const renamed = await get('/api/tracker/mc-99636') as TrackerSummary
    expect(renamed).toMatchObject({ id: task.id, trackerKey: 'MC-99636', title: 'Починить отчёт Ёж' })
    expect(await get(`/api/diagrams/${task.id}`)).toMatchObject(renamed)
    const found = await get('/api/tracker?q=' + encodeURIComponent('ОТЧЁТ ёж')) as TrackerPage
    expect(found.items.map(item => item.id)).toEqual([task.id])
    const repeated = await fetch(url + '/api/tracker/MC-99636', { method: 'POST' })
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toEqual(renamed)
    const readOnly = await backend.collaboration.openDirectConnection(task.id)
    expect(projectTree(readOnly.document!).nodes.get(child)?.text).toBe('Деталь')
    await readOnly.disconnect()
    expect(await get('/api/tracker/MC-99636')).toEqual(renamed)
    await backend.close()
    backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
    url = `http://127.0.0.1:${await backend.listen(0)}`
    expect(await get('/api/tracker/MC-99636')).toEqual(renamed)
    const reopened = await backend.collaboration.openDirectConnection(task.id)
    expect(projectTree(reopened.document!).nodes.get(child)?.text).toBe('Деталь')
    new TreeCommands(reopened.document!).setText(ROOT_ID, '')
    await reopened.disconnect()
    expect(await get('/api/tracker/MC-99636')).toMatchObject({ title: 'MC-99636', id: task.id })
    expect((await get('/api/tracker?q=' + encodeURIComponent('отчёт')) as TrackerPage).items).toHaveLength(0)
    expect((await get('/api/tracker?q=99636') as TrackerPage).items).toHaveLength(1)
  } finally { await backend.close(); await rm(dataDir, { recursive: true, force: true }) }
}, 30000)

it('searches beyond the first page and orders by persisted edits, not reads or presence', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-tracker-list-'))
  const backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  try {
    const url = `http://127.0.0.1:${await backend.listen(0)}`
    const tasks: TrackerSummary[] = []
    for (let index = 1; index <= 25; index++) tasks.push(await (await fetch(`${url}/api/tracker/MC-${index}`, { method: 'POST' })).json())
    const list = async (query = ''): Promise<TrackerPage> => (await fetch(`${url}/api/tracker${query}`)).json()
    const first = await list()
    expect(first.items).toHaveLength(20)
    expect(first.nextOffset).toBe(20)
    const last = await list('?offset=20')
    expect(last.items).toHaveLength(5)
    expect(last.nextOffset).toBeNull()
    expect(new Set([...first.items, ...last.items].map(item => item.id)).size).toBe(25)
    const matched = (await list('?q=mc-1')).items
    expect(matched).toHaveLength(11)
    expect(matched.some(item => item.id === tasks[0].id)).toBe(true)
    expect(matched.every(item => item.trackerKey.includes('MC-1'))).toBe(true)
    const oldest = tasks[0]
    const live = await backend.collaboration.openDirectConnection(oldest.id)
    live.document!.awareness.setLocalState({ user: { name: 'Тест' }, activeNode: ROOT_ID })
    await live.disconnect()
    expect(await list()).toEqual(first)
    const edit = await backend.collaboration.openDirectConnection(oldest.id)
    const commands = new TreeCommands(edit.document!)
    commands.createChild(ROOT_ID, 'Не название')
    await edit.disconnect()
    expect((await list()).items[0].id).toBe(oldest.id)
    expect((await list('?q=' + encodeURIComponent('Не название'))).items).toHaveLength(0)
    for (const query of ['?offset=-1', '?offset=x', '?offset=9007199254740992', '?q=a&q=b']) {
      expect((await fetch(`${url}/api/tracker${query}`)).status).toBe(400)
    }
    expect((await fetch(`${url}/tracker/MC-1`)).status).toBe(200)
  } finally { await backend.close(); await rm(dataDir, { recursive: true, force: true }) }
}, 30000)
