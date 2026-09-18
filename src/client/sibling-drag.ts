import type { TreeProjection } from '../domain'
import { NODE_WIDTH } from './layout'

export interface Point { x: number; y: number }
export interface SiblingDrag {
  id: string
  parentId: string
  siblings: { id: string; placementId: string | null; position: Point; height: number }[]
}
export interface DropTarget { index: number; anchorId: string; side: 'before' | 'after' }
export interface DragPreview {
  snapshot: SiblingDrag
  position: Point
  target: DropTarget | null
  phase: 'dragging' | 'settling'
}

export function beginSiblingDrag(
  tree: TreeProjection, id: string,
  positions: ReadonlyMap<string, Point>, heights: ReadonlyMap<string, number>,
): SiblingDrag | null {
  const parentId = tree.nodes.get(id)?.parentId
  if (!parentId) return null
  const ids = tree.children.get(parentId) ?? []
  if (ids.length < 2 || ids.some(sibling => !positions.has(sibling) || !heights.has(sibling))) return null
  return {
    id, parentId,
    siblings: ids.map(sibling => ({
      id: sibling, placementId: tree.nodes.get(sibling)!.placementId,
      position: positions.get(sibling)!, height: heights.get(sibling)!,
    })),
  }
}

export function isSiblingDragValid(tree: TreeProjection, drag: SiblingDrag): boolean {
  if (tree.nodes.get(drag.id)?.parentId !== drag.parentId) return false
  const siblings = tree.children.get(drag.parentId) ?? []
  return siblings.length === drag.siblings.length && drag.siblings.every((node, index) => (
    siblings[index] === node.id && tree.nodes.get(node.id)?.placementId === node.placementId
  ))
}

export function siblingDropTarget(drag: SiblingDrag, position: Point): DropTarget | null {
  const source = drag.siblings.find(node => node.id === drag.id)!
  // За пределами исходной колонки drop отменяется, а не становится reparent.
  const centerX = position.x + NODE_WIDTH / 2
  if (centerX < source.position.x - 40 || centerX > source.position.x + NODE_WIDTH + 40) return null
  const siblings = drag.siblings.filter(node => node.id !== drag.id)
  const centerY = position.y + source.height / 2
  const next = siblings.findIndex(node => centerY < node.position.y + node.height / 2)
  const index = next === -1 ? siblings.length : next
  if (index === drag.siblings.findIndex(node => node.id === drag.id)) return null
  return next === -1
    ? { index, anchorId: siblings.at(-1)!.id, side: 'after' }
    : { index, anchorId: siblings[next].id, side: 'before' }
}
