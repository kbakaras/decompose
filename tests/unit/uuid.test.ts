import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createUuid } from '../../src/shared/uuid'
import { createIdentityStore } from '../../src/client/identity'
import { createImportedDocument, getStructures, initializeDocument, projectTree, ROOT_ID, TreeCommands } from '../../src/domain'

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('prefers native randomUUID with its Crypto receiver', () => {
  const id = '12345678-1234-4234-8234-123456789abc'
  const crypto = { randomUUID: vi.fn(function (this: unknown) { expect(this).toBe(crypto); return id }), getRandomValues: vi.fn() }
  vi.stubGlobal('crypto', crypto)
  expect(createUuid()).toBe(id)
  expect(crypto.randomUUID).toHaveBeenCalledOnce()
  expect(crypto.getRandomValues).not.toHaveBeenCalled()
})

it.each([0x00, 0xff, 0x55, 0xaa])('sets v4 version and variant and preserves padding for byte %i', value => {
  const crypto = { getRandomValues: vi.fn(function (this: unknown, bytes: Uint8Array) {
    expect(this).toBe(crypto)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).toHaveLength(16)
    return bytes.fill(value)
  }) }
  vi.stubGlobal('crypto', crypto)
  const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random must not be used') })
  const id = createUuid()
  expect(id).toMatch(uuidV4)
  const bytes = Buffer.from(id.replaceAll('-', ''), 'hex')
  expect(bytes[6]).toBe((value & 0x0f) | 0x40)
  expect(bytes[8]).toBe((value & 0x3f) | 0x80)
  expect(bytes[0]).toBe(value)
  if (value === 0) expect(id).toBe('00000000-0000-4000-8000-000000000000')
  expect(crypto.getRandomValues).toHaveBeenCalledOnce()
  expect(random).not.toHaveBeenCalled()
})

it.each([undefined, {}])('fails explicitly without a secure random source (%j)', crypto => {
  vi.stubGlobal('crypto', crypto)
  const random = vi.spyOn(Math, 'random')
  expect(createUuid).toThrow('Недоступна безопасная генерация идентификаторов')
  expect(random).not.toHaveBeenCalled()
})

it('does not hide an entropy source failure with an insecure fallback', () => {
  vi.stubGlobal('crypto', { getRandomValues() { throw new Error('entropy unavailable') } })
  expect(createUuid).toThrow('entropy unavailable')
})

it('creates persistent identities, tree operations and imported placements without randomUUID', () => {
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
  const values = new Map<string, string>()
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } })
  const identity = createIdentityStore(storage)
  identity.save('Анна')
  expect(identity.snapshot().id).toMatch(uuidV4)
  expect(createIdentityStore(storage).snapshot()).toEqual(identity.snapshot())
  const doc = new Y.Doc()
  const imported = createImportedDocument({ nodes: [
    { id: 'parent', text: 'Корень', status: 'open', children: ['child'] },
    { id: 'child', text: 'Ребёнок', status: 'done', children: [] },
  ] })
  try {
    initializeDocument(doc)
    const commands = new TreeCommands(doc)
    const first = commands.createChild(ROOT_ID, 'Первый')
    const second = commands.createSibling(first, 'Второй')
    expect(first).toMatch(uuidV4)
    expect(second).toMatch(uuidV4)
    commands.indent(second)
    expect(projectTree(doc).nodes.get(second)?.parentId).toBe(first)
    commands.deleteSubtree(second)
    expect(projectTree(doc).nodes.has(second)).toBe(false)
    for (const treeDoc of [doc, imported]) {
      for (const [id, record] of getStructures(treeDoc).nodes) {
        if (id === ROOT_ID) continue
        expect(id).toMatch(uuidV4)
        expect((record.get('placement') as { placementId: string }).placementId).toMatch(uuidV4)
      }
    }
    expect(projectTree(imported).children.get(ROOT_ID)).toHaveLength(1)
  } finally { doc.destroy(); imported.destroy() }
})
