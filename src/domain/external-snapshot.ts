import * as Y from 'yjs'
import { validateDiagramFile, type DiagramFile } from '../shared/diagram-file'
import { createUuid } from '../shared/uuid'
import { createNodeRecord, getStructures, readPlacement, ROOT_ID, SCHEMA_VERSION, type OrderEntry, type Placement } from './schema'

/**
 * Делает проверенный снимок файла авторитетным состоянием документа.
 * Операция не попадает в пользовательскую undo-историю.
 */
export function applyExternalSnapshot(doc: Y.Doc, value: unknown): DiagramFile {
  const file = validateDiagramFile(value)
  const { meta, nodes, orders, deletions, settings } = getStructures(doc)
  const targetIds = new Set(file.nodes.map(node => node.id))
  const parents = new Map<string, string>()
  for (const node of file.nodes) for (const child of node.children) parents.set(child, node.id)
  const placements = new Map<string, Placement>()
  for (const node of file.nodes) {
    if (node.id === ROOT_ID) continue
    const parentId = parents.get(node.id)!
    const existing = nodes.get(node.id)
    const placement = existing ? readPlacement(existing) : null
    placements.set(node.id, placement?.parentId === parentId
      ? placement
      : { parentId, placementId: createUuid() })
  }

  doc.transact(() => {
    meta.set('schemaVersion', SCHEMA_VERSION)
    meta.set('rootId', ROOT_ID)
    for (const id of [...nodes.keys()]) if (!targetIds.has(id)) nodes.delete(id)
    for (const id of [...orders.keys()]) if (!targetIds.has(id)) orders.delete(id)
    deletions.clear()

    for (const source of file.nodes) {
      const placement = source.id === ROOT_ID ? null : placements.get(source.id)!
      const node = nodes.get(source.id)
      if (node) {
        node.set('text', source.text)
        node.set('status', source.status)
        node.set('placement', placement)
        node.set('deleted', false)
        if (source.targetTrackerKey) node.set('targetTrackerKey', source.targetTrackerKey)
        else node.delete('targetTrackerKey')
      } else {
        nodes.set(source.id, createNodeRecord(source.text, source.status, placement, source.targetTrackerKey))
      }
      let order = orders.get(source.id)
      if (!order) { order = new Y.Array<OrderEntry>(); orders.set(source.id, order) }
      else if (order.length) order.delete(0, order.length)
      order.push(source.children.map(child => ({ nodeId: child, placementId: placements.get(child)!.placementId })))
    }
    settings.set('textAlign', file.settings.textAlign)
  }, 'external-file')
  return file
}
