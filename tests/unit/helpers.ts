import * as Y from 'yjs'
import { fileURLToPath } from 'node:url'
import { ROOT_ID, projectTree, type TreeProjection } from '../../src/domain'

export const TEST_CLIENT_DIR = fileURLToPath(new URL('../fixtures/client/', import.meta.url))

export function cloneDocument(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc()
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source))
  return clone
}

export function mergeDocuments(left: Y.Doc, right: Y.Doc, reverse = false): Y.Doc {
  const merged = new Y.Doc()
  const updates = [Y.encodeStateAsUpdate(left), Y.encodeStateAsUpdate(right)]
  if (reverse) updates.reverse()
  for (const update of updates) Y.applyUpdate(merged, update)
  return merged
}

export function treeSnapshot(doc: Y.Doc) {
  const tree = projectTree(doc)
  return {
    nodes: [...tree.nodes.values()]
      .map(node => ({ ...node, children: [...(tree.children.get(node.id) ?? [])] }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export function assertTreeInvariants(tree: TreeProjection): void {
  const root = tree.nodes.get(ROOT_ID)
  if (root === undefined) throw new Error('root is missing')
  if (root.parentId !== null) throw new Error('root has a parent')

  const visited = new Set<string>()
  const stack = [ROOT_ID]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) continue
    if (visited.has(id)) throw new Error(`cycle or duplicate node: ${id}`)
    visited.add(id)
    for (const childId of tree.children.get(id) ?? []) {
      const child = tree.nodes.get(childId)
      if (child === undefined) throw new Error(`unknown child: ${childId}`)
      if (child.parentId !== id) throw new Error(`wrong parent for ${childId}`)
      stack.push(childId)
    }
  }

  if (visited.size !== tree.nodes.size) {
    throw new Error(`unreachable nodes: expected ${tree.nodes.size}, got ${visited.size}`)
  }
}

export function sequentialIds(prefix: string): () => string {
  let counter = 0
  return () => `${prefix}-${String(counter++).padStart(4, '0')}`
}

export async function createTestDiagram(url: string, title = 'Тестовая схема'): Promise<string> {
  const response = await fetch(`${url}/api/diagrams`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  })
  if (!response.ok) throw new Error(`Не удалось создать тестовую схему: ${response.status}`)
  return (await response.json()).id
}
