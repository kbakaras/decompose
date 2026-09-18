import { normalizeText, type NodeStatus } from '../domain/schema'

export const IMPORT_FILE_LIMIT = 5 * 1024 * 1024
export const IMPORT_JSON_LIMIT = 1024 * 1024
export const IMPORT_NODE_LIMIT = 1000

export interface ImportNode {
  id: string
  text: string
  status: NodeStatus
  children: string[]
}

export class ImportError extends Error {
  readonly status = 400
}

/** Проверяет дерево до любых изменений документа; не применяет CRDT-восстановление. */
export function validateImport(value: unknown): { nodes: ImportNode[]; rootId: string } {
  if (!value || typeof value !== 'object' || !('nodes' in value) || !Array.isArray(value.nodes)) {
    throw new ImportError('Ожидается список узлов схемы.')
  }
  if (!value.nodes.length || value.nodes.length > IMPORT_NODE_LIMIT) {
    throw new ImportError(`Схема должна содержать от 1 до ${IMPORT_NODE_LIMIT} узлов.`)
  }
  const nodes: ImportNode[] = []
  const ids = new Set<string>()
  for (const node of value.nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id.trim()
      || typeof node.text !== 'string' || !['open', 'done'].includes(node.status)
      || !Array.isArray(node.children) || node.children.some((id: unknown) => typeof id !== 'string')) {
      throw new ImportError('Узел должен содержать ID, текст, статус open/done и список детей.')
    }
    if (ids.has(node.id)) throw new ImportError('В схеме повторяются ID узлов.')
    ids.add(node.id)
    nodes.push({ id: node.id, text: normalizeText(node.text), status: node.status, children: [...node.children] })
  }
  const parents = new Set<string>()
  for (const node of nodes) {
    for (const child of node.children) {
      if (!ids.has(child)) throw new ImportError('Связь ссылается на отсутствующий узел.')
      if (parents.has(child)) throw new ImportError('Узел имеет несколько входящих связей. Требуется дерево.')
      parents.add(child)
    }
  }
  const roots = nodes.filter(node => !parents.has(node.id))
  if (roots.length !== 1) throw new ImportError('Схема должна иметь ровно один корень, без циклов.')
  const byId = new Map(nodes.map(node => [node.id, node]))
  const visited = new Set<string>()
  const pending = [roots[0].id]
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id)) throw new ImportError('Схема содержит цикл.')
    visited.add(id)
    pending.push(...byId.get(id)!.children)
  }
  if (visited.size !== nodes.length) throw new ImportError('В схеме есть цикл или узлы, недостижимые из корня.')
  return { nodes, rootId: roots[0].id }
}
