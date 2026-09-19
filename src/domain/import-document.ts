import * as Y from 'yjs'
import { validateImport } from '../shared/diagram-import'
import { createUuid } from '../shared/uuid'
import { validateDiagramFile } from '../shared/diagram-file'
import { createNodeRecord, getStructures, ROOT_ID, SCHEMA_VERSION, type OrderEntry, type Placement } from './schema'

/** Импорт всегда создаёт отдельный документ, без команд и записей undo. */
export function createImportedDocument(value: unknown): Y.Doc {
  const native = value && typeof value === 'object' && 'format' in value ? validateDiagramFile(value) : null
  const tree = validateImport(native ?? value, native ? Infinity : undefined)
  const doc = new Y.Doc()
  const { meta, nodes, orders } = getStructures(doc)
  const ids = new Map(tree.nodes.map(node => [node.id, node.id === tree.rootId ? ROOT_ID : createUuid()]))
  const placements = new Map<string, Placement>()
  for (const node of tree.nodes) {
    for (const child of node.children) placements.set(child, { parentId: ids.get(node.id)!, placementId: createUuid() })
  }
  doc.transact(() => {
    meta.set('schemaVersion', SCHEMA_VERSION)
    meta.set('rootId', ROOT_ID)
    if (native) getStructures(doc).settings.set('textAlign', native.settings.textAlign)
    for (const node of tree.nodes) {
      const id = ids.get(node.id)!
      nodes.set(id, createNodeRecord(node.text, node.status, placements.get(node.id) ?? null))
      const entries = new Y.Array<OrderEntry>()
      entries.push(node.children.map(child => ({ nodeId: ids.get(child)!, placementId: placements.get(child)!.placementId })))
      orders.set(id, entries)
    }
  }, 'initialize-document')
  return doc
}
