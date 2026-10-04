import * as Y from 'yjs'
import { normalizeTrackerKey } from '../shared/tracker'

export const SCHEMA_VERSION = 3
export const ROOT_ID = 'root'

export type NodeId = string
export type NodeStatus = 'open' | 'done'
export type TextAlign = 'left' | 'center'

export interface Placement {
  parentId: NodeId
  placementId: string
}

export interface OrderEntry {
  nodeId: NodeId
  placementId: string
}

export interface NodeUpdate {
  at: number
  by: string
}

export interface StatusRestore {
  status: NodeStatus
  updated: NodeUpdate | null
  contentRevision: string
}

export interface NodeMetadata {
  updated?: NodeUpdate
  contentRevision?: string
  statusRestore?: StatusRestore
}

export type NodeRecord = Y.Map<unknown>
export type NodesMap = Y.Map<NodeRecord>
export type OrdersMap = Y.Map<Y.Array<OrderEntry>>

export interface DocumentStructures {
  meta: Y.Map<unknown>
  nodes: NodesMap
  orders: OrdersMap
  deletions: Y.Map<NodeId>
  settings: Y.Map<unknown>
}

export function getStructures(doc: Y.Doc): DocumentStructures {
  return {
    meta: doc.getMap<unknown>('meta'),
    nodes: doc.getMap<NodeRecord>('nodes'),
    orders: doc.getMap<Y.Array<OrderEntry>>('orders'),
    deletions: doc.getMap<NodeId>('deletions'),
    settings: doc.getMap<unknown>('settings'),
  }
}

export function createNodeRecord(
  text: string,
  status: NodeStatus,
  placement: Placement | null,
  targetTrackerKey?: string,
  metadata: NodeMetadata = {},
): NodeRecord {
  const node = new Y.Map<unknown>()
  node.set('text', normalizeText(text))
  node.set('status', status)
  if (targetTrackerKey !== undefined) node.set('targetTrackerKey', targetTrackerKey)
  node.set('placement', placement)
  node.set('deleted', false)
  if (metadata.updated) node.set('updated', metadata.updated)
  if (metadata.contentRevision) node.set('contentRevision', metadata.contentRevision)
  if (metadata.statusRestore) node.set('statusRestore', metadata.statusRestore)
  return node
}

export function initializeDocument(doc: Y.Doc, textAlign?: TextAlign, metadata: NodeMetadata = {}): void {
  const { meta, nodes, orders, settings } = getStructures(doc)

  doc.transact(() => {
    if (meta.get('schemaVersion') === undefined || meta.get('schemaVersion') === 1 || meta.get('schemaVersion') === 2) {
      meta.set('schemaVersion', SCHEMA_VERSION)
    }
    if (meta.get('rootId') === undefined) {
      meta.set('rootId', ROOT_ID)
    }
    if (!nodes.has(ROOT_ID)) {
      nodes.set(ROOT_ID, createNodeRecord('Новая декомпозиция', 'open', null, undefined, metadata))
    }
    if (!orders.has(ROOT_ID)) {
      orders.set(ROOT_ID, new Y.Array<OrderEntry>())
    }
    if (textAlign !== undefined && settings.get('textAlign') === undefined) {
      settings.set('textAlign', textAlign)
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

export function readTrackerLink(node: NodeRecord): string | null {
  return normalizeTrackerKey(node.get('targetTrackerKey'))
}

export function normalizeUpdateAuthor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name && [...name].length <= 80 && !/[\r\n]/.test(name) ? name : null
}

export function readNodeUpdateValue(value: unknown): NodeUpdate | null {
  if (!value || typeof value !== 'object' || !('at' in value) || !('by' in value)) return null
  const by = normalizeUpdateAuthor(value.by)
  const at = typeof value.at === 'number' ? value.at : NaN
  return Number.isSafeInteger(at) && at >= 0 && by !== null
    ? { at, by }
    : null
}

export function readNodeUpdate(node: NodeRecord): NodeUpdate | null {
  return readNodeUpdateValue(node.get('updated'))
}

export function readContentRevision(node: NodeRecord): string | null {
  const value = node.get('contentRevision')
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function readStatusRestore(node: NodeRecord): StatusRestore | null {
  const value = node.get('statusRestore')
  if (!value || typeof value !== 'object'
    || !('status' in value) || !('updated' in value) || !('contentRevision' in value)
    || (value.status !== 'open' && value.status !== 'done')
    || typeof value.contentRevision !== 'string' || !value.contentRevision) return null
  const updated = value.updated === null ? null : readNodeUpdateValue(value.updated)
  if (value.updated !== null && updated === null) return null
  return { status: value.status, updated, contentRevision: value.contentRevision }
}

export function isDeleted(node: NodeRecord): boolean {
  return node.get('deleted') === true
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export function readTextAlign(doc: Y.Doc): TextAlign {
  return getStructures(doc).settings.get('textAlign') === 'center' ? 'center' : 'left'
}
