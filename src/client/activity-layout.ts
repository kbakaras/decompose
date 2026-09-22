import ELK from 'elkjs/lib/elk.bundled.js'
import { NODE_MIN_HEIGHT, NODE_WIDTH } from './layout'

const elk = new ELK()

export async function layoutActivity(rootId: string, children: ReadonlyMap<string, readonly string[]>, heights: ReadonlyMap<string, number>) {
  const ids: string[] = []
  const visit = (id: string) => {
    ids.push(id)
    for (const child of children.get(id) ?? []) visit(child)
  }
  visit(rootId)
  const graph = await elk.layout({
    id: 'activity',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    },
    children: ids.map(id => ({ id, width: NODE_WIDTH, height: heights.get(id) ?? NODE_MIN_HEIGHT })),
    edges: ids.flatMap(parent => (children.get(parent) ?? []).map(child => ({
      id: `${parent}:${child}`, sources: [parent], targets: [child],
    }))),
  })
  return new Map((graph.children ?? []).map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]))
}
