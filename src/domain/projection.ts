import type { NodeId, NodeStatus, Placement } from './schema'
import {
  ROOT_ID,
  getStructures,
  isDeleted,
  readPlacement,
  readStatus,
  readText,
  readTrackerLink,
} from './schema'
import type * as Y from 'yjs'

export interface ProjectedNode {
  id: NodeId
  text: string
  status: NodeStatus
  targetTrackerKey: string | null
  parentId: NodeId | null
  placementId: string | null
  recovered: boolean
}

export interface TreeProjection {
  rootId: typeof ROOT_ID
  nodes: ReadonlyMap<NodeId, ProjectedNode>
  children: ReadonlyMap<NodeId, readonly NodeId[]>
}

interface CandidateNode {
  id: NodeId
  text: string
  status: NodeStatus
  targetTrackerKey: string | null
  placement: Placement | null
}

export function projectTree(doc: Y.Doc): TreeProjection {
  const { nodes: rawNodes, orders, deletions } = getStructures(doc)
  const hidden = new Set(deletions.values())
  const candidates = new Map<NodeId, CandidateNode>()

  rawNodes.forEach((node, id) => {
    if (id !== ROOT_ID && (isDeleted(node) || hidden.has(id))) return
    candidates.set(id, {
      id,
      text: readText(node),
      status: readStatus(node),
      targetTrackerKey: readTrackerLink(node),
      placement: id === ROOT_ID ? null : readPlacement(node),
    })
  })

  if (!candidates.has(ROOT_ID)) {
    candidates.set(ROOT_ID, {
      id: ROOT_ID,
      text: 'Новая декомпозиция',
      status: 'open',
      targetTrackerKey: null,
      placement: null,
    })
  }

  const parents = new Map<NodeId, NodeId>()
  const recovered = new Set<NodeId>()

  candidates.forEach((node, id) => {
    if (id === ROOT_ID) return
    const requestedParent = node.placement?.parentId
    if (
      requestedParent === undefined
      || requestedParent === id
      || !candidates.has(requestedParent)
    ) {
      parents.set(id, ROOT_ID)
      recovered.add(id)
      return
    }
    parents.set(id, requestedParent)
  })

  breakCycles(candidates, parents, recovered)

  const children = new Map<NodeId, NodeId[]>()
  candidates.forEach((_node, id) => children.set(id, []))
  const ordered = new Set<NodeId>()

  orders.forEach((order, parentId) => {
    if (!candidates.has(parentId)) return
    for (const entry of order.toArray()) {
      const node = candidates.get(entry.nodeId)
      if (
        node === undefined
        || ordered.has(entry.nodeId)
        || parents.get(entry.nodeId) !== parentId
        || node.placement?.parentId !== parentId
        || node.placement.placementId !== entry.placementId
      ) {
        continue
      }
      children.get(parentId)?.push(entry.nodeId)
      ordered.add(entry.nodeId)
    }
  })

  const unorderedByParent = new Map<NodeId, NodeId[]>()
  candidates.forEach((_node, id) => {
    if (id === ROOT_ID || ordered.has(id)) return
    const parentId = parents.get(id) ?? ROOT_ID
    const bucket = unorderedByParent.get(parentId) ?? []
    bucket.push(id)
    unorderedByParent.set(parentId, bucket)
    recovered.add(id)
  })
  unorderedByParent.forEach((ids, parentId) => {
    ids.sort()
    children.get(parentId)?.push(...ids)
  })

  const projected = new Map<NodeId, ProjectedNode>()
  candidates.forEach((node, id) => {
    projected.set(id, {
      id,
      text: node.text,
      status: node.status,
      targetTrackerKey: node.targetTrackerKey,
      parentId: id === ROOT_ID ? null : (parents.get(id) ?? ROOT_ID),
      placementId: node.placement?.placementId ?? null,
      recovered: recovered.has(id),
    })
  })

  return {
    rootId: ROOT_ID,
    nodes: projected,
    children,
  }
}

function breakCycles(
  nodes: ReadonlyMap<NodeId, CandidateNode>,
  parents: Map<NodeId, NodeId>,
  recovered: Set<NodeId>,
): void {
  const state = new Map<NodeId, 0 | 1 | 2>()
  const stack: NodeId[] = []
  const stackIndexes = new Map<NodeId, number>()

  const visit = (id: NodeId): void => {
    state.set(id, 1)
    stackIndexes.set(id, stack.length)
    stack.push(id)

    const parentId = parents.get(id)
    if (parentId !== undefined && parentId !== ROOT_ID) {
      const parentState = state.get(parentId) ?? 0
      if (parentState === 0) {
        visit(parentId)
      } else if (parentState === 1) {
        const cycleStart = stackIndexes.get(parentId)
        if (cycleStart !== undefined) {
          const cycle = stack.slice(cycleStart)
          const breaker = cycle.reduce((current, candidate) => {
            const currentPlacement = nodes.get(current)?.placement?.placementId ?? ''
            const candidatePlacement = nodes.get(candidate)?.placement?.placementId ?? ''
            if (candidatePlacement > currentPlacement) return candidate
            if (candidatePlacement === currentPlacement && candidate > current) return candidate
            return current
          })
          parents.set(breaker, ROOT_ID)
          recovered.add(breaker)
        }
      }
    }

    stack.pop()
    stackIndexes.delete(id)
    state.set(id, 2)
  }

  nodes.forEach((_node, id) => {
    if (id !== ROOT_ID && (state.get(id) ?? 0) === 0) visit(id)
  })
}

export function descendantsOf(tree: TreeProjection, nodeId: NodeId): NodeId[] {
  const result: NodeId[] = []
  const pending = [nodeId]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    result.push(current)
    pending.push(...(tree.children.get(current) ?? []))
  }
  return result
}

export function isDescendantOf(
  tree: TreeProjection,
  nodeId: NodeId,
  possibleAncestorId: NodeId,
): boolean {
  let current = tree.nodes.get(nodeId)?.parentId ?? null
  while (current !== null) {
    if (current === possibleAncestorId) return true
    current = tree.nodes.get(current)?.parentId ?? null
  }
  return false
}
