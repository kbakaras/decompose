import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { initializeDocument, ROOT_ID, TreeCommands, projectTree } from '../../src/domain'
import { beginTreeDrag, isTreeDragValid, treeDropTarget } from '../../src/client/sibling-drag'

function geometry(doc: Y.Doc) {
  const tree = projectTree(doc)
  const positions = new Map<string, { x: number; y: number }>([[ROOT_ID, { x: 0, y: 200 }]])
  const heights = new Map<string, number>([[ROOT_ID, 80]])
  const visit = (parentId: string, depth: number) => {
    for (const [index, id] of (tree.children.get(parentId) ?? []).entries()) {
      positions.set(id, { x: depth * 350, y: index * 200 })
      heights.set(id, index === 1 ? 160 : 104)
      visit(id, depth + 1)
    }
  }
  visit(ROOT_ID, 1)
  return { tree, positions, heights }
}

function setup() {
  const doc = new Y.Doc()
  initializeDocument(doc)
  const commands = new TreeCommands(doc)
  const ids = [0, 1, 2].map(() => commands.createChild(ROOT_ID))
  return { doc, commands, ids, ...geometry(doc) }
}

it('finds child and sibling targets from the pointer without changing the document', () => {
  const { doc, ids, tree, positions, heights } = setup()
  const drag = beginTreeDrag(tree, ids[2], positions, heights)!
  let updates = 0
  doc.on('update', () => updates++)
  expect(treeDropTarget(drag, { x: 490, y: 50 })).toEqual({
    kind: 'child', parentId: ids[0], index: 0, anchorId: ids[0],
  })
  expect(treeDropTarget(drag, { x: 490, y: -10 })).toEqual({
    kind: 'sibling', parentId: ROOT_ID, index: 0, anchorId: ids[0], side: 'before',
  })
  expect(treeDropTarget(drag, { x: 490, y: 110 })).toEqual({
    kind: 'sibling', parentId: ROOT_ID, index: 1, anchorId: ids[0], side: 'after',
  })
  expect(treeDropTarget(drag, { x: 490, y: 440 })).toBeNull()
  expect(treeDropTarget(drag, { x: 900, y: -10 })).toBeNull()
  expect(updates).toBe(0)
})

it('allows a single child but rejects root, descendants and unmeasured nodes', () => {
  const { doc, commands, ids } = setup()
  const child = commands.createChild(ids[0])
  const nested = commands.createChild(child)
  const { tree, positions, heights } = geometry(doc)
  expect(beginTreeDrag(tree, ROOT_ID, positions, heights)).toBeNull()
  expect(beginTreeDrag(tree, ids[0], new Map(), heights)).toBeNull()
  const drag = beginTreeDrag(tree, nested, positions, heights)
  expect(drag).not.toBeNull()
  const ancestorDrag = beginTreeDrag(tree, ids[0], positions, heights)!
  const childPosition = positions.get(child)!
  expect(treeDropTarget(ancestorDrag, { x: childPosition.x + 100, y: childPosition.y + 30 })).toBeNull()
})

it('keeps content changes but rejects stale source or destination structure', () => {
  const { doc, commands, ids } = setup()
  let { tree, positions, heights } = geometry(doc)
  const drag = beginTreeDrag(tree, ids[2], positions, heights)!
  const target = treeDropTarget(drag, { x: 490, y: 50 })!
  commands.setText(ids[0], 'Другой текст')
  commands.toggleStatus(ids[2])
  expect(isTreeDragValid(projectTree(doc), drag, target)).toBe(true)
  commands.createChild(ids[0])
  expect(isTreeDragValid(projectTree(doc), drag, target)).toBe(false)

  const next = geometry(doc)
  tree = next.tree
  positions = next.positions
  heights = next.heights
  const fresh = beginTreeDrag(tree, ids[2], positions, heights)!
  commands.move(ids[2], ids[0], 0)
  expect(isTreeDragValid(projectTree(doc), fresh)).toBe(false)
  commands.deleteSubtree(ids[2])
  expect(isTreeDragValid(projectTree(doc), fresh)).toBe(false)
})
