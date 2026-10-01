import type { TreeProjection } from '../domain'
import { NODE_WIDTH } from './layout'

export interface Point { x: number; y: number }
interface DragNode {
  id: string
  parentId: string | null
  placementId: string | null
  position: Point
  height: number
  children: string[]
}
export interface TreeDrag {
  id: string
  parentId: string
  nodes: DragNode[]
}
export type DropTarget = {
  kind: 'sibling'
  parentId: string
  index: number
  anchorId: string
  side: 'before' | 'after'
  indicator: { x: number; y: number; width: number }
} | {
  kind: 'child'
  parentId: string
  index: number
  anchorId: string
}
export interface DragPreview {
  snapshot: TreeDrag
  position: Point
  target: DropTarget | null
  phase: 'dragging' | 'settling'
}

const DROP_MARGIN = 18
const INDICATOR_INSET = 8
const OUTER_INDICATOR_OFFSET = 12
type SiblingTarget = Extract<DropTarget, { kind: 'sibling' }>
interface SiblingSlot {
  target: SiblingTarget
  left: number
  right: number
  top: number
  bottom: number
}

export function beginTreeDrag(
  tree: TreeProjection, id: string,
  positions: ReadonlyMap<string, Point>, heights: ReadonlyMap<string, number>,
): TreeDrag | null {
  const parentId = tree.nodes.get(id)?.parentId
  if (!parentId || [...tree.nodes.keys()].some(nodeId => !positions.has(nodeId) || !heights.has(nodeId))) return null
  return {
    id,
    parentId,
    nodes: [...tree.nodes.values()].map(node => ({
      id: node.id,
      parentId: node.parentId,
      placementId: node.placementId,
      position: positions.get(node.id)!,
      height: heights.get(node.id)!,
      children: [...(tree.children.get(node.id) ?? [])],
    })),
  }
}

export function isTreeDragValid(tree: TreeProjection, drag: TreeDrag, target: DropTarget | null = null): boolean {
  const snapshot = new Map(drag.nodes.map(node => [node.id, node]))
  const source = snapshot.get(drag.id)
  const currentSource = tree.nodes.get(drag.id)
  if (!source || !currentSource || currentSource.parentId !== source.parentId || currentSource.placementId !== source.placementId) return false
  if (!sameChildren(tree, snapshot.get(drag.parentId), snapshot)) return false
  if (!target) return true
  const anchor = snapshot.get(target.anchorId)
  const currentAnchor = tree.nodes.get(target.anchorId)
  if (!anchor || !currentAnchor || currentAnchor.parentId !== anchor.parentId || currentAnchor.placementId !== anchor.placementId) return false
  return sameChildren(tree, snapshot.get(target.parentId), snapshot)
}

export function treeDropTarget(drag: TreeDrag, pointer: Point): DropTarget | null {
  const nodes = new Map(drag.nodes.map(node => [node.id, node]))
  const source = nodes.get(drag.id)
  if (!source) return null

  const body = drag.nodes.find(node => node.id !== drag.id
    && inside(pointer, node.position.x, node.position.y, NODE_WIDTH, node.height))
  if (body && validParent(nodes, drag.id, body.id)) {
    const siblings = body.children.filter(id => id !== drag.id)
    const target = { kind: 'child', parentId: body.id, index: siblings.length, anchorId: body.id } as const
    return isNoop(source, nodes, target) ? null : target
  }

  const slot = siblingSlots(drag, nodes)
    .filter(candidate => pointer.x >= candidate.left && pointer.x <= candidate.right
      && pointer.y >= candidate.top && pointer.y <= candidate.bottom
      && !isNoop(source, nodes, candidate.target))
    .sort((left, right) => (
      Math.abs(pointer.y - left.target.indicator.y) - Math.abs(pointer.y - right.target.indicator.y)
      || left.target.parentId.localeCompare(right.target.parentId)
      || left.target.index - right.target.index
    ))[0]
  return slot?.target ?? null
}

function siblingSlots(drag: TreeDrag, nodes: ReadonlyMap<string, DragNode>): SiblingSlot[] {
  const slots: SiblingSlot[] = []
  for (const parent of drag.nodes) {
    if (!validParent(nodes, drag.id, parent.id)) continue
    const siblings = parent.children
      .filter(id => id !== drag.id)
      .map(id => nodes.get(id))
      .filter(node => node !== undefined)
    const first = siblings[0]
    const last = siblings.at(-1)
    if (!first || !last) continue

    slots.push({
      target: siblingTarget(parent.id, 0, first, 'before', first.position.y - OUTER_INDICATOR_OFFSET),
      left: first.position.x - DROP_MARGIN,
      right: first.position.x + NODE_WIDTH + DROP_MARGIN,
      top: first.position.y - DROP_MARGIN,
      bottom: first.position.y,
    })
    for (let index = 1; index < siblings.length; index++) {
      const upper = siblings[index - 1]!
      const lower = siblings[index]!
      const top = upper.position.y + upper.height
      const bottom = lower.position.y
      const left = Math.max(upper.position.x, lower.position.x) - DROP_MARGIN
      const right = Math.min(upper.position.x + NODE_WIDTH, lower.position.x + NODE_WIDTH) + DROP_MARGIN
      if (top > bottom || left > right) continue
      slots.push({
        target: siblingTarget(parent.id, index, upper, 'after', (top + bottom) / 2,
          (upper.position.x + lower.position.x) / 2),
        left, right, top, bottom,
      })
    }
    const lastBottom = last.position.y + last.height
    slots.push({
      target: siblingTarget(parent.id, siblings.length, last, 'after', lastBottom + OUTER_INDICATOR_OFFSET),
      left: last.position.x - DROP_MARGIN,
      right: last.position.x + NODE_WIDTH + DROP_MARGIN,
      top: lastBottom,
      bottom: lastBottom + DROP_MARGIN,
    })
  }
  return slots
}

function siblingTarget(
  parentId: string, index: number, anchor: DragNode, side: 'before' | 'after', y: number,
  x = anchor.position.x,
): SiblingTarget {
  return {
    kind: 'sibling', parentId, index, anchorId: anchor.id, side,
    indicator: { x: x - INDICATOR_INSET, y, width: NODE_WIDTH + INDICATOR_INSET * 2 },
  }
}

function sameChildren(
  tree: TreeProjection,
  parent: DragNode | undefined,
  snapshot: ReadonlyMap<string, DragNode>,
): boolean {
  if (!parent || !tree.nodes.has(parent.id)) return false
  const current = tree.children.get(parent.id) ?? []
  return current.length === parent.children.length && parent.children.every((id, index) => (
    current[index] === id && tree.nodes.get(id)?.placementId === snapshot.get(id)?.placementId
  ))
}

function validParent(nodes: ReadonlyMap<string, DragNode>, sourceId: string, parentId: string): boolean {
  let current: string | null = parentId
  while (current !== null) {
    if (current === sourceId) return false
    current = nodes.get(current)?.parentId ?? null
  }
  return true
}

function isNoop(source: DragNode, nodes: ReadonlyMap<string, DragNode>, target: DropTarget): boolean {
  if (source.parentId !== target.parentId) return false
  const oldIndex = (nodes.get(target.parentId)?.children ?? []).indexOf(source.id)
  const siblingCount = (nodes.get(target.parentId)?.children ?? []).filter(id => id !== source.id).length
  return oldIndex === Math.max(0, Math.min(target.index, siblingCount))
}

function inside(point: Point, x: number, y: number, width: number, height: number): boolean {
  return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height
}
