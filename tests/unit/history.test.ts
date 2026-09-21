import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { DocumentHistory, ROOT_ID, TreeCommands, getStructures, initializeDocument, projectTree } from '../../src/domain'
import { assertTreeInvariants, cloneDocument, sequentialIds, treeSnapshot } from './helpers'

function setup() {
  const doc = new Y.Doc()
  initializeDocument(doc)
  const commands = new TreeCommands(doc, sequentialIds('local'))
  const first = commands.createChild(ROOT_ID, 'Первый')
  const second = commands.createChild(ROOT_ID, 'Второй')
  const child = commands.createChild(first, 'Деталь')
  const history = new DocumentHistory(doc)
  return { doc, commands, first, second, child, history }
}

function sync(left: Y.Doc, right: Y.Doc) {
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left), 'network')
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right), 'network')
}

describe('DocumentHistory', () => {
  it('undoes and redoes each atomic command independently, retaining node identities and order', () => {
    const { doc, commands, first, second, history } = setup()
    const states = [treeSnapshot(doc)]
    const operations = [
      () => commands.setText(first, 'Новый текст'),
      () => commands.setTrackerLink(first, 'HISTORY-1'),
      () => commands.toggleStatus(first),
      () => commands.reorder(second, -1),
      () => commands.indent(first),
      () => commands.outdent(first),
      () => commands.createSibling(first, 'Новый узел'),
      () => commands.deleteSubtree(first),
    ]
    for (const operation of operations) {
      operation()
      states.push(treeSnapshot(doc))
    }
    for (let i = operations.length - 1; i >= 0; i--) {
      expect(history.undo()).not.toBeNull()
      expect(treeSnapshot(doc)).toEqual(states[i])
      assertTreeInvariants(projectTree(doc))
    }
    expect(history.canUndo).toBe(false)
    for (let i = 1; i < states.length; i++) {
      expect(history.redo()).not.toBeNull()
      expect(treeSnapshot(doc)).toEqual(states[i])
    }
    expect(history.canRedo).toBe(false)
    history.destroy()
    doc.destroy()
  })

  it('ignores unchanged text, clears redo on a new command and discards cancelled creation', () => {
    const { doc, commands, first, history } = setup()
    commands.setText(first, 'Первый')
    expect(history.canUndo).toBe(false)
    commands.toggleStatus(first)
    history.undo()
    commands.setText(first, 'Первый')
    expect(history.canRedo).toBe(true)
    commands.setText(first, 'Правка')
    expect(history.canRedo).toBe(false)
    const node = commands.createChild(first)
    expect(history.cancelCreation(node)).toBe(true)
    expect(projectTree(doc).nodes.has(node)).toBe(false)
    expect(history.canRedo).toBe(false)
    history.undo()
    expect(projectTree(doc).nodes.get(first)?.text).toBe('Первый')
    expect(history.canUndo).toBe(false)
    history.destroy()
    const fresh = new DocumentHistory(doc)
    expect(fresh.canUndo).toBe(false)
    expect(fresh.canRedo).toBe(false)
    fresh.destroy()
    doc.destroy()
  })

  it('never tracks remote commands or overwrites a newer remote text on undo', () => {
    const { doc, commands, first, history } = setup()
    const remote = cloneDocument(doc)
    const remoteCommands = new TreeCommands(remote)
    commands.setText(first, 'Своя правка')
    sync(doc, remote)
    remoteCommands.setText(first, 'Чужая правка')
    remoteCommands.toggleStatus(first)
    sync(doc, remote)
    history.undo()
    expect(projectTree(doc).nodes.get(first)).toMatchObject({ text: 'Чужая правка', status: 'done' })
    expect(history.canUndo).toBe(false)
    sync(doc, remote)
    expect(treeSnapshot(doc)).toEqual(treeSnapshot(remote))
    history.destroy()
    doc.destroy()
    remote.destroy()
  })

  it('does not overwrite a newer remote tracker link on undo', () => {
    const { doc, commands, first, history } = setup()
    const remote = cloneDocument(doc)
    const remoteCommands = new TreeCommands(remote)
    commands.setTrackerLink(first, 'LOCAL-1')
    sync(doc, remote)
    remoteCommands.setTrackerLink(first, 'REMOTE-2')
    sync(doc, remote)

    history.undo()
    expect(projectTree(doc).nodes.get(first)?.targetTrackerKey).toBe('REMOTE-2')
    sync(doc, remote)
    expect(treeSnapshot(doc)).toEqual(treeSnapshot(remote))
    history.destroy()
    doc.destroy()
    remote.destroy()
  })

  it.each([[100, 900], [900, 100]])('keeps independent concurrent deletions when undoing either (%i, %i)', (leftId, rightId) => {
    const { doc, first, child, history: initialHistory } = setup()
    initialHistory.destroy()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)
    left.clientID = leftId
    right.clientID = rightId
    const lh = new DocumentHistory(left)
    const rh = new DocumentHistory(right)
    new TreeCommands(left, sequentialIds('left')).deleteSubtree(first)
    new TreeCommands(right, sequentialIds('right')).deleteSubtree(first)
    sync(left, right)
    lh.undo()
    sync(left, right)
    expect(projectTree(left).nodes.has(first)).toBe(false)
    expect(projectTree(left).nodes.has(child)).toBe(false)
    rh.undo()
    sync(left, right)
    expect(treeSnapshot(left)).toEqual(treeSnapshot(doc))
    expect(treeSnapshot(right)).toEqual(treeSnapshot(doc))
    lh.redo()
    sync(left, right)
    expect(projectTree(right).nodes.has(first)).toBe(false)
    lh.destroy()
    rh.destroy()
    left.destroy()
    right.destroy()
    doc.destroy()
  })

  it.each([100, 900])('does not erase a required field when concurrent replacements prevent restoration (%i)', clientId => {
    const { doc, first, history } = setup()
    history.destroy()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)
    left.clientID = clientId
    right.clientID = 1000 - clientId
    const localHistory = new DocumentHistory(left)
    new TreeCommands(left).setText(first, 'Своя версия')
    new TreeCommands(right).setText(first, 'Чужая версия')
    sync(left, right)
    const winner = projectTree(left).nodes.get(first)?.text
    localHistory.undo()
    expect(projectTree(left).nodes.get(first)?.text).toBe(winner)
    sync(left, right)
    expect(treeSnapshot(left)).toEqual(treeSnapshot(right))
    localHistory.destroy()
    left.destroy()
    right.destroy()
    doc.destroy()
  })

  it('undo creation preserves remote text and new children, redo reveals the same node', () => {
    const { doc, commands, history } = setup()
    const node = commands.createChild(ROOT_ID)
    const remote = cloneDocument(doc)
    const rc = new TreeCommands(remote, sequentialIds('remote'))
    rc.setText(node, 'Чужой текст')
    const child = rc.createChild(node, 'Чужой ребёнок')
    sync(doc, remote)
    history.undo()
    expect(projectTree(doc).nodes.has(node)).toBe(false)
    expect(projectTree(doc).nodes.get(child)?.parentId).toBe(ROOT_ID)
    expect(getStructures(doc).nodes.get(node)?.get('text')).toBe('Чужой текст')
    history.redo()
    expect(projectTree(doc).nodes.get(node)?.text).toBe('Чужой текст')
    expect(projectTree(doc).nodes.get(child)?.parentId).toBe(node)
    sync(doc, remote)
    expect(treeSnapshot(doc)).toEqual(treeSnapshot(remote))
    history.destroy()
    doc.destroy()
    remote.destroy()
  })

  it('undo deletion retains a concurrent reparent and an unknown child', () => {
    const { doc, commands, first, second, child, history } = setup()
    const remote = cloneDocument(doc)
    const rc = new TreeCommands(remote, sequentialIds('remote'))
    commands.deleteSubtree(first)
    rc.move(child, second, 0)
    const newChild = rc.createChild(first, 'Поздняя деталь')
    sync(doc, remote)
    expect(projectTree(doc).nodes.get(newChild)?.parentId).toBe(ROOT_ID)
    history.undo()
    expect(projectTree(doc).nodes.get(child)?.parentId).toBe(second)
    expect(projectTree(doc).nodes.get(newChild)?.parentId).toBe(first)
    sync(doc, remote)
    expect(treeSnapshot(doc)).toEqual(treeSnapshot(remote))
    assertTreeInvariants(projectTree(doc))
    history.destroy()
    doc.destroy()
    remote.destroy()
  })

  it('undo move does not revert a newer remote move or detach children', () => {
    const { doc, commands, first, second, child, history } = setup()
    const remote = cloneDocument(doc)
    commands.move(first, second, 0)
    sync(doc, remote)
    new TreeCommands(remote).move(first, ROOT_ID, 0)
    sync(doc, remote)
    history.undo()
    expect(projectTree(doc).nodes.get(first)?.parentId).toBe(ROOT_ID)
    expect(projectTree(doc).nodes.get(child)?.parentId).toBe(first)
    sync(doc, remote)
    expect(treeSnapshot(doc)).toEqual(treeSnapshot(remote))
    assertTreeInvariants(projectTree(doc))
    history.destroy()
    doc.destroy()
    remote.destroy()
  })
})
