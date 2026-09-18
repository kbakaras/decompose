import { ROOT_ID, type TreeProjection } from '../domain'

export function focusAfterRemoval(previous: TreeProjection, next: TreeProjection, active: string): string {
  if (next.nodes.has(active)) return active
  const parent = previous.nodes.get(active)?.parentId
  const siblings = previous.children.get(parent ?? ROOT_ID) ?? []
  const index = siblings.indexOf(active)
  const alternatives = [
    ...siblings.slice(index + 1),
    ...siblings.slice(0, index).reverse(),
    parent,
    ROOT_ID,
  ]
  return alternatives.find((id): id is string => !!id && next.nodes.has(id)) ?? ROOT_ID
}

export function navigate(tree: TreeProjection, active: string, key: string): string {
  const node = tree.nodes.get(active)
  if (!node) return ROOT_ID
  if (key === 'ArrowLeft') return node.parentId ?? active
  if (key === 'ArrowRight') return tree.children.get(active)?.[0] ?? active
  const siblings = tree.children.get(node.parentId ?? '') ?? []
  const index = siblings.indexOf(active)
  if (key === 'ArrowUp') return siblings[index - 1] ?? active
  if (key === 'ArrowDown') return siblings[index + 1] ?? active
  return active
}
