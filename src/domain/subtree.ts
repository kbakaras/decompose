import { validateImport, type ImportNode } from '../shared/diagram-import'
import type { TreeProjection } from './projection'
import type { NodeId } from './schema'

export const SUBTREE_CLIPBOARD_FORMAT = 'decompose-subtree'
export const SUBTREE_CLIPBOARD_VERSION = 1

export interface SubtreeSnapshot {
  format: typeof SUBTREE_CLIPBOARD_FORMAT
  version: typeof SUBTREE_CLIPBOARD_VERSION
  rootId: string
  nodes: ImportNode[]
}

/** Снимок содержит только наблюдаемую предметную структуру, без Yjs и геометрии. */
export function captureSubtree(tree: TreeProjection, rootId: NodeId): SubtreeSnapshot {
  if (!tree.nodes.has(rootId)) throw new Error('Карточка больше не видна.')
  const nodes: ImportNode[] = []
  const pending = [rootId]
  while (pending.length > 0) {
    const id = pending.pop()!
    const node = tree.nodes.get(id)
    if (!node) throw new Error('Поддерево изменилось во время копирования.')
    const children = [...(tree.children.get(id) ?? [])]
    nodes.push({
      id,
      text: node.text,
      status: node.status,
      ...(node.targetTrackerKey ? { targetTrackerKey: node.targetTrackerKey } : {}),
      children,
    })
    pending.push(...children.toReversed())
  }
  return {
    format: SUBTREE_CLIPBOARD_FORMAT,
    version: SUBTREE_CLIPBOARD_VERSION,
    rootId,
    nodes,
  }
}

export function validateSubtreeSnapshot(value: unknown): SubtreeSnapshot {
  if (!value || typeof value !== 'object'
    || !('format' in value) || value.format !== SUBTREE_CLIPBOARD_FORMAT
    || !('version' in value) || value.version !== SUBTREE_CLIPBOARD_VERSION
    || !('rootId' in value) || typeof value.rootId !== 'string') {
    throw new Error('В буфере нет поддерева дерево·дел.')
  }
  const tree = validateImport(value)
  if (tree.rootId !== value.rootId) throw new Error('В буфере повреждён корень поддерева.')
  return {
    format: SUBTREE_CLIPBOARD_FORMAT,
    version: SUBTREE_CLIPBOARD_VERSION,
    rootId: tree.rootId,
    nodes: tree.nodes,
  }
}
