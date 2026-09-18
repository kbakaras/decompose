import { expect, it } from 'vitest'
import fc from 'fast-check'
import * as Y from 'yjs'
import { validateImport, type ImportNode } from '../../src/shared/diagram-import'
import { isGreenFill } from '../../src/client/yed-import'
import { createImportedDocument, DocumentHistory, getStructures, projectTree, ROOT_ID, SCHEMA_VERSION, TreeCommands } from '../../src/domain'
import { assertTreeInvariants } from './helpers'

const node = (id: string, children: string[] = []): ImportNode => ({ id, text: id, status: 'open', children })

it('recognizes green hues, including the yEd sample, but not yellow, gray or unknown formats', () => {
  for (const color of ['#99CC00', '#00FF00', '#00cc66', '#003300', '#55FF00', '#00FFCC', '#ccffcc', '#c8f000', '#00f0c8']) expect(isGreenFill(color)).toBe(true)
  for (const color of ['#FFCC00', '#FFFF99', '#FFFF00', '#FF0000', '#0000FF', '#00FFFF', '#FFFFFF', '#000000', '#eeeeee', '#eeffee', '#0f0', '#00FF0080', 'green', null]) expect(isGreenFill(color)).toBe(false)
})

it('rejects malformed, ambiguous and disconnected graphs rather than repairing them', () => {
  const invalid: unknown[] = [null, {}, { nodes: [] }, { nodes: [node('')] }, { nodes: [node('a'), node('a')] },
    { nodes: [node('a'), node('b')] }, { nodes: [node('a', ['missing'])] },
    { nodes: [node('a', ['a'])] }, { nodes: [node('a', ['b']), node('b', ['a'])] },
    { nodes: [node('a'), node('b', ['c']), node('c', ['b'])] },
    { nodes: [node('a', ['b', 'b']), node('b')] },
    { nodes: [node('a', ['b', 'c']), node('b', ['c']), node('c')] },
    { nodes: [{ ...node('a'), status: 'green' }] }, { nodes: [{ ...node('a'), text: 3 }] },
    { nodes: [{ ...node('a'), children: [3] }] }, { nodes: Array.from({ length: 1001 }, (_, i) => node(String(i))) }]
  for (const value of invalid) expect(() => validateImport(value)).toThrow()
})

it('initializes fresh IDs, ordered placements and empty leaf orders without importing history or geometry', () => {
  const input = { nodes: [node('source', ['z', 'a']), { ...node('z'), text: 'Текст\r\nузла', status: 'done' }, node('a')] }
  const doc = createImportedDocument(input)
  const other = createImportedDocument(input)
  const history = new DocumentHistory(doc)
  try {
    const tree = projectTree(doc)
    assertTreeInvariants(tree)
    const children = tree.children.get(ROOT_ID)!
    expect(children.map(id => tree.nodes.get(id)?.text)).toEqual(['Текст узла', 'a'])
    expect(tree.nodes.get(children[0])?.status).toBe('done')
    expect([...tree.nodes.values()].every(n => !n.recovered)).toBe(true)
    expect(children.every(id => !['source', 'z', 'a'].includes(id) && !projectTree(other).nodes.has(id))).toBe(true)
    expect(getStructures(doc).orders.size).toBe(3)
    expect(getStructures(doc).meta.get('schemaVersion')).toBe(SCHEMA_VERSION)
    expect(history.canUndo).toBe(false)
    new TreeCommands(doc).setText(children[0], 'Изменено')
    history.undo()
    expect(projectTree(doc).nodes.get(children[0])?.text).toBe('Текст узла')
    history.redo()
    expect(projectTree(doc).nodes.get(children[0])?.text).toBe('Изменено')
    const restored = new Y.Doc()
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc))
    expect(projectTree(restored)).toEqual(projectTree(doc))
    restored.destroy()
  } finally { history.destroy(); doc.destroy(); other.destroy() }
})

it('preserves arbitrary valid trees independently of flat node order', () => {
  fc.assert(fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 150 }), choices => {
    const nodes = choices.map((_, i) => node(`source-${i}`))
    for (let i = 1; i < nodes.length; i++) nodes[choices[i] % i].children.unshift(nodes[i].id)
    const doc = createImportedDocument({ nodes: [...nodes].reverse() })
    try {
      const tree = projectTree(doc)
      assertTreeInvariants(tree)
      const byText = new Map([...tree.nodes.values()].map(n => [n.text, n.id]))
      for (const original of nodes) {
        expect(tree.children.get(byText.get(original.text)!)?.map(id => tree.nodes.get(id)!.text)).toEqual(original.children)
      }
    } finally { doc.destroy() }
  }), { numRuns: 80 })
})

it('accepts the node limit, including a deep chain without recursive validation', () => {
  const nodes = Array.from({ length: 1000 }, (_, i) => node(String(i), i < 999 ? [String(i + 1)] : []))
  expect(validateImport({ nodes }).rootId).toBe('0')
  const doc = createImportedDocument({ nodes })
  try { assertTreeInvariants(projectTree(doc)); expect(getStructures(doc).nodes.size).toBe(1000) }
  finally { doc.destroy() }
})
