import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { initializeDocument, ROOT_ID, TreeCommands, projectTree } from '../../src/domain'
import { beginSiblingDrag, isSiblingDragValid, siblingDropTarget } from '../../src/client/sibling-drag'

function setup() {
  const doc = new Y.Doc()
  initializeDocument(doc)
  const commands = new TreeCommands(doc)
  const ids = [0, 1, 2].map(() => commands.createChild(ROOT_ID))
  const positions = new Map(ids.map((id, index) => [id, { x: 350, y: index * 200 }]))
  const heights = new Map(ids.map((id, index) => [id, index === 1 ? 160 : 104]))
  const tree = projectTree(doc)
  return { doc, commands, ids, tree, positions, heights }
}

it('calculates insertion slots with unequal heights, without changing the document', () => {
  const { doc, ids, tree, positions, heights } = setup()
  const drag = beginSiblingDrag(tree, ids[2], positions, heights)!
  let updates = 0
  doc.on('update', () => updates++)
  expect(siblingDropTarget(drag, { x: 350, y: -30 })).toEqual({ index: 0, anchorId: ids[0], side: 'before' })
  expect(siblingDropTarget(drag, { x: 350, y: 200 })).toEqual({ index: 1, anchorId: ids[1], side: 'before' })
  expect(siblingDropTarget(drag, positions.get(ids[2])!)).toBeNull()
  expect(siblingDropTarget(drag, { x: 800, y: -30 })).toBeNull()
  const first = beginSiblingDrag(tree, ids[0], positions, heights)!
  expect(siblingDropTarget(first, { x: 350, y: 500 })).toEqual({ index: 2, anchorId: ids[2], side: 'after' })
  expect(updates).toBe(0)
})

it('rejects root, single siblings and unmeasured nodes', () => {
  const { commands, ids, tree, positions, heights, doc } = setup()
  expect(beginSiblingDrag(tree, ROOT_ID, positions, heights)).toBeNull()
  expect(beginSiblingDrag(tree, ids[0], new Map(), heights)).toBeNull()
  expect(beginSiblingDrag(tree, ids[0], positions, new Map())).toBeNull()
  const only = commands.createChild(ids[0])
  expect(beginSiblingDrag(projectTree(doc), only, positions, heights)).toBeNull()
})

it('keeps text and status changes, but rejects stale structure on drop', () => {
  const { doc, commands, ids, tree, positions, heights } = setup()
  const drag = beginSiblingDrag(tree, ids[2], positions, heights)!
  commands.setText(ids[0], 'Другой текст')
  commands.toggleStatus(ids[2])
  expect(isSiblingDragValid(projectTree(doc), drag)).toBe(true)
  commands.reorder(ids[0], 1)
  expect(isSiblingDragValid(projectTree(doc), drag)).toBe(false)
  commands.reorder(ids[0], -1)
  expect(isSiblingDragValid(projectTree(doc), drag)).toBe(false)
  const fresh = beginSiblingDrag(projectTree(doc), ids[2], positions, heights)!
  commands.move(ids[2], ids[0], 0)
  expect(isSiblingDragValid(projectTree(doc), fresh)).toBe(false)
  commands.deleteSubtree(ids[2])
  expect(isSiblingDragValid(projectTree(doc), fresh)).toBe(false)
})
