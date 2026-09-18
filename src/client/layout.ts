import ELK from 'elkjs/lib/elk.bundled.js'
import type { TreeProjection } from '../domain'

export const NODE_WIDTH = 280
export const NODE_MIN_HEIGHT = 44
const elk = new ELK()

export async function layoutTree(tree: TreeProjection, heights: ReadonlyMap<string, number>) {
  const ids: string[] = []
  const visit = (id: string) => {
    ids.push(id)
    for (const child of tree.children.get(id) ?? []) visit(child)
  }
  visit(tree.rootId)
  const graph = await elk.layout({
    id: 'canvas',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
    },
    children: ids.map(id => ({ id, width: NODE_WIDTH, height: heights.get(id) ?? NODE_MIN_HEIGHT })),
    edges: ids.flatMap(parent => (tree.children.get(parent) ?? []).map(child => ({
      id: `${parent}:${child}`, sources: [parent], targets: [child],
    }))),
  })
  return new Map((graph.children ?? []).map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]))
}
