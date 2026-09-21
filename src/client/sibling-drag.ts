import { ROOT_ID, type TreeProjection } from '../domain'
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

  const line = drag.nodes
    .filter(node => node.id !== drag.id && node.id !== ROOT_ID && node.parentId
      && validParent(nodes, drag.id, node.parentId)
      && pointer.x >= node.position.x - 18 && pointer.x <= node.position.x + NODE_WIDTH + 18)
    .flatMap(node => ([
      { node, side: 'before' as const, distance: Math.abs(pointer.y - node.position.y) },
      { node, side: 'after' as const, distance: Math.abs(pointer.y - node.position.y - node.height) },
    ]))
    .filter(candidate => candidate.distance <= 18)
    .sort((left, right) => left.distance - right.distance)[0]
  if (!line || !line.node.parentId) return null
  const siblings = nodes.get(line.node.parentId)?.children.filter(id => id !== drag.id) ?? []
  const anchorIndex = siblings.indexOf(line.node.id)
  if (anchorIndex < 0) return null
  const target: DropTarget = {
    kind: 'sibling',
    parentId: line.node.parentId,
    index: anchorIndex + (line.side === 'after' ? 1 : 0),
    anchorId: line.node.id,
    side: line.side,
  }
  return isNoop(source, nodes, target) ? null : target
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
