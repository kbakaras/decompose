import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBackend } from '../../src/server/app'
import { projectTree, ROOT_ID } from '../../src/domain'

it('imports atomically, revalidates untrusted input, enforces route-specific limits and survives restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-import-'))
  let backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  try {
    let url = `http://127.0.0.1:${await backend.listen(0)}`
    const post = (body: unknown, route = '/api/diagrams/import') => fetch(`${url}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const node = (id: string, children: string[] = []) => ({ id, text: id, status: 'open', children })
    for (const body of [null, {}, { nodes: [] }, { nodes: [node('a'), node('a')] },
      { nodes: [node('a', ['missing'])] }, { nodes: [node('a', ['b']), node('b', ['a'])] },
      { nodes: [node('a'), node('b', ['b'])] }, { nodes: [node('a', ['b', 'b']), node('b')] },
      { nodes: [{ ...node('a'), status: 'other' }] },
      { nodes: Array.from({ length: 1001 }, (_, i) => node(String(i))) }]) {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect((await post({ nodes: [{ ...node('a'), text: 'x'.repeat(1024 * 1024) }] })).status).toBe(413)
    expect((await post({ title: 'x'.repeat(17 * 1024) }, '/api/diagrams')).status).toBe(413)
    expect((await fetch(`${url}/api/diagrams/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400)
    expect(await (await fetch(`${url}/api/diagrams`)).json()).toHaveLength(0)
    const source = { nodes: [node('a', ['b', 'c']), { ...node('b'), text: 'x'.repeat(20000), status: 'done' }, node('c')] }
    const response = await post(source)
    expect(response.status).toBe(201)
    const created = await response.json()
    expect(created.title).toBe('a')
    const imported = await backend.collaboration.openDirectConnection(created.id)
    const tree = projectTree(imported.document!)
    expect(tree.nodes.size).toBe(3)
    const children = tree.children.get(ROOT_ID)!
    expect(tree.nodes.get(children[0])?.status).toBe('done')
    expect(tree.nodes.get(children[1])?.text).toBe('c')
    await imported.disconnect()
    const emptyRoot = await post({ nodes: [{ ...node('a'), text: '' }] })
    expect((await emptyRoot.json()).title).toBe('Новая декомпозиция')
    await backend.close()
    backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
    url = `http://127.0.0.1:${await backend.listen(0)}`
    const restored = await backend.collaboration.openDirectConnection(created.id)
    expect(projectTree(restored.document!)).toEqual(tree)
    await restored.disconnect()
    expect(await (await fetch(`${url}/api/diagrams`)).json()).toHaveLength(2)
  } finally { await backend.close(); await rm(dataDir, { recursive: true, force: true }) }
}, 30000)
