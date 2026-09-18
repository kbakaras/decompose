import * as Y from 'yjs'

export const SCHEMA_VERSION = 2
export const ROOT_ID = 'root'

export type NodeId = string
export type NodeStatus = 'open' | 'done'

export interface Placement {
  parentId: NodeId
  placementId: string
}

export interface OrderEntry {
  nodeId: NodeId
  placementId: string
}

export type NodeRecord = Y.Map<unknown>
export type NodesMap = Y.Map<NodeRecord>
export type OrdersMap = Y.Map<Y.Array<OrderEntry>>

export interface DocumentStructures {
  meta: Y.Map<unknown>
  nodes: NodesMap
  orders: OrdersMap
  deletions: Y.Map<NodeId>
}

export function getStructures(doc: Y.Doc): DocumentStructures {
  return {
    meta: doc.getMap<unknown>('meta'),
    nodes: doc.getMap<NodeRecord>('nodes'),
    orders: doc.getMap<Y.Array<OrderEntry>>('orders'),
    deletions: doc.getMap<NodeId>('deletions'),
  }
}

export function createNodeRecord(
  text: string,
  status: NodeStatus,
  placement: Placement | null,
): NodeRecord {
  const node = new Y.Map<unknown>()
  node.set('text', normalizeText(text))
  node.set('status', status)
  node.set('placement', placement)
  node.set('deleted', false)
  return node
}

export function initializeDocument(doc: Y.Doc): void {
  const { meta, nodes, orders } = getStructures(doc)

  doc.transact(() => {
    if (meta.get('schemaVersion') === undefined || meta.get('schemaVersion') === 1) {
      meta.set('schemaVersion', SCHEMA_VERSION)
    }
    if (meta.get('rootId') === undefined) {
      meta.set('rootId', ROOT_ID)
    }
    if (!nodes.has(ROOT_ID)) {
      nodes.set(ROOT_ID, createNodeRecord('Новая декомпозиция', 'open', null))
    }
    if (!orders.has(ROOT_ID)) {
      orders.set(ROOT_ID, new Y.Array<OrderEntry>())
    }
  }, 'initialize-document')
}

export function readPlacement(node: NodeRecord): Placement | null {
  const value = node.get('placement')
  if (
    typeof value === 'object'
    && value !== null
    && 'parentId' in value
    && 'placementId' in value
    && typeof value.parentId === 'string'
    && typeof value.placementId === 'string'
  ) {
    return {
      parentId: value.parentId,
      placementId: value.placementId,
    }
  }
  return null
}

export function readText(node: NodeRecord): string {
  const value = node.get('text')
  return typeof value === 'string' ? value : ''
}

export function readStatus(node: NodeRecord): NodeStatus {
  return node.get('status') === 'done' ? 'done' : 'open'
}

export function isDeleted(node: NodeRecord): boolean {
  return node.get('deleted') === true
}

export function normalizeText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ')
}
