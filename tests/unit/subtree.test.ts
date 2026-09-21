import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  DocumentHistory,
  ROOT_ID,
  TreeCommands,
  captureSubtree,
  initializeDocument,
  projectTree,
  validateSubtreeSnapshot,
} from '../../src/domain'
import { parseSerializedSubtree, serializeSubtree, subtreeOutline } from '../../src/client/tree-clipboard'
import { sequentialIds } from './helpers'

function sourceTree() {
  const doc = new Y.Doc()
  initializeDocument(doc)
  const commands = new TreeCommands(doc, sequentialIds('source'))
  const parent = commands.createChild(ROOT_ID, 'Родитель\nс переносом')
  const first = commands.createChild(parent, 'Первый')
  const second = commands.createChild(parent, 'Второй')
  commands.toggleStatus(first)
  commands.setTrackerLink(second, 'MC-42')
  return { doc, commands, parent, first, second }
}

describe('subtree clipboard data', () => {
  it('captures semantic fields and projected child order', () => {
    const { doc, commands, parent, first, second } = sourceTree()
    commands.reorder(second, -1)
    const snapshot = captureSubtree(projectTree(doc), parent)
    expect(snapshot.nodes).toEqual([
      { id: parent, text: 'Родитель\nс переносом', status: 'open', children: [second, first] },
      { id: second, text: 'Второй', status: 'open', targetTrackerKey: 'MC-42', children: [] },
      { id: first, text: 'Первый', status: 'done', children: [] },
    ])
    expect(parseSerializedSubtree(serializeSubtree(snapshot))).toEqual(snapshot)
    expect(subtreeOutline(snapshot)).toBe('Родитель\n  с переносом\n  Второй\n  Первый')
    doc.destroy()
  })

  it('rejects foreign, malformed and oversized clipboard data', () => {
    expect(() => validateSubtreeSnapshot({ nodes: [] })).toThrow(/нет поддерева/)
    expect(() => parseSerializedSubtree('{"format":"unknown"}')).toThrow(/корректного поддерева/)
    const { doc, parent } = sourceTree()
    const snapshot = captureSubtree(projectTree(doc), parent)
    snapshot.nodes[0].text = 'я'.repeat(6 * 1024 * 1024)
    expect(() => serializeSubtree(snapshot)).toThrow(/5 МиБ/)
    doc.destroy()
  })
})

describe('TreeCommands.insertSubtree', () => {
  it('creates fresh identities as the last child and preserves content', () => {
    const source = sourceTree()
    const snapshot = captureSubtree(projectTree(source.doc), source.parent)
    const target = new Y.Doc()
    initializeDocument(target)
    const commands = new TreeCommands(target, sequentialIds('copy'))
    const existing = commands.createChild(ROOT_ID, 'Существующая')
    const firstCopy = commands.insertSubtree(ROOT_ID, snapshot)
    const secondCopy = commands.insertSubtree(ROOT_ID, snapshot)
    const tree = projectTree(target)
    expect(tree.children.get(ROOT_ID)).toEqual([existing, firstCopy, secondCopy])
    expect(firstCopy).not.toBe(source.parent)
    expect(secondCopy).not.toBe(firstCopy)
    const firstChildren = tree.children.get(firstCopy) ?? []
    expect(firstChildren.map(id => tree.nodes.get(id))).toMatchObject([
      { text: 'Первый', status: 'done', targetTrackerKey: null },
      { text: 'Второй', status: 'open', targetTrackerKey: 'MC-42' },
    ])
    source.doc.destroy()
    target.destroy()
  })

  it('undoes and redoes the whole pasted subtree as one action', () => {
    const source = sourceTree()
    const snapshot = captureSubtree(projectTree(source.doc), source.parent)
    const target = new Y.Doc()
    initializeDocument(target)
    const commands = new TreeCommands(target, sequentialIds('copy'))
    const history = new DocumentHistory(target)
    const root = commands.insertSubtree(ROOT_ID, snapshot)
    const createdIds = [root, ...(projectTree(target).children.get(root) ?? [])]
    expect(history.canUndo).toBe(true)
    history.undo()
    for (const id of createdIds) expect(projectTree(target).nodes.has(id)).toBe(false)
    expect(history.canUndo).toBe(false)
    history.redo()
    for (const id of createdIds) expect(projectTree(target).nodes.has(id)).toBe(true)
    expect(projectTree(target).children.get(root)).toHaveLength(2)
    history.destroy()
    source.doc.destroy()
    target.destroy()
  })
})
