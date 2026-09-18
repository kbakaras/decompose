import * as Y from 'yjs'
import {
  ROOT_ID,
  createNodeRecord,
  getStructures,
  normalizeText,
  readPlacement,
  readStatus,
  readTextAlign,
  type TextAlign,
  type NodeId,
  type NodeRecord,
  type OrderEntry,
  type Placement,
} from './schema'
import {
  descendantsOf,
  isDescendantOf,
  projectTree,
  type TreeProjection,
} from './projection'

export type IdFactory = () => string

export class CommandOrigin {
  constructor(
    public readonly kind: 'set-text' | 'toggle-status' | 'move-node' | 'delete-subtree' | 'create-node' | 'set-text-align',
    public readonly nodeId: NodeId,
  ) {}
}

export class DomainError extends Error {
  constructor(
    public readonly code:
      | 'node-not-found'
      | 'root-operation'
      | 'invalid-parent'
      | 'cycle'
      | 'invalid-operation',
    message: string,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export class TreeCommands {
  constructor(
    private readonly doc: Y.Doc,
    private readonly createId: IdFactory = () => globalThis.crypto.randomUUID(),
  ) {}

  createChild(parentId: NodeId, text = ''): NodeId {
    const tree = projectTree(this.doc)
    this.assertLiveNode(tree, parentId)
    return this.createAt(parentId, tree.children.get(parentId)?.length ?? 0, text)
  }

  createSibling(nodeId: NodeId, text = ''): NodeId {
    const tree = projectTree(this.doc)
    const node = this.assertLiveNode(tree, nodeId)
    if (node.parentId === null) {
      throw new DomainError('root-operation', 'У root не может быть sibling')
    }
    const siblings = tree.children.get(node.parentId) ?? []
    return this.createAt(node.parentId, siblings.indexOf(nodeId) + 1, text)
  }

  setText(nodeId: NodeId, text: string): void {
    const node = this.requireRecord(nodeId)
    const normalized = normalizeText(text)
    if (node.get('text') === normalized) return
    this.doc.transact(() => node.set('text', normalized), new CommandOrigin('set-text', nodeId))
  }

  toggleStatus(nodeId: NodeId): void {
    const node = this.requireRecord(nodeId)
    this.doc.transact(() => {
      node.set('status', readStatus(node) === 'open' ? 'done' : 'open')
    }, new CommandOrigin('toggle-status', nodeId))
  }

  setTextAlign(value: TextAlign): void {
    if (value !== 'left' && value !== 'center') throw new DomainError('invalid-operation', 'Неизвестное выравнивание текста')
    if (readTextAlign(this.doc) === value) return
    this.doc.transact(() => getStructures(this.doc).settings.set('textAlign', value), new CommandOrigin('set-text-align', ROOT_ID))
  }

  move(nodeId: NodeId, parentId: NodeId, index: number): void {
    const tree = projectTree(this.doc)
    this.assertLiveNode(tree, nodeId)
    this.assertLiveNode(tree, parentId)
    if (nodeId === ROOT_ID) {
      throw new DomainError('root-operation', 'Root нельзя перемещать')
    }
    if (nodeId === parentId || isDescendantOf(tree, parentId, nodeId)) {
      throw new DomainError('cycle', 'Перемещение создаст цикл')
    }

    const targetSiblings = [...(tree.children.get(parentId) ?? [])].filter(id => id !== nodeId)
    const targetIndex = Math.max(0, Math.min(index, targetSiblings.length))
    const nextSiblingId = targetSiblings[targetIndex]
    const record = this.requireRecord(nodeId)
    const oldPlacement = readPlacement(record)
    const placement: Placement = {
      parentId,
      placementId: this.uniqueId('placement'),
    }

    this.doc.transact(() => {
      this.materializeRecoveredSiblings(tree, parentId, nodeId)
      if (oldPlacement !== null) this.removeOrderEntry(nodeId, oldPlacement)
      const order = this.requireOrder(parentId)
      const rawIndex = nextSiblingId === undefined
        ? order.length
        : this.rawIndexForNode(order, nextSiblingId)
      order.insert(rawIndex < 0 ? order.length : rawIndex, [{
        nodeId,
        placementId: placement.placementId,
      }])
      record.set('placement', placement)
    }, new CommandOrigin('move-node', nodeId))
  }

  reorder(nodeId: NodeId, delta: -1 | 1): void {
    const tree = projectTree(this.doc)
    const node = this.assertLiveNode(tree, nodeId)
    if (node.parentId === null) {
      throw new DomainError('root-operation', 'Root нельзя переупорядочить')
    }
    const siblings = tree.children.get(node.parentId) ?? []
    const currentIndex = siblings.indexOf(nodeId)
    const targetIndex = currentIndex + delta
    if (targetIndex < 0 || targetIndex >= siblings.length) {
      throw new DomainError('invalid-operation', 'Узел уже находится на границе списка')
    }
    this.move(nodeId, node.parentId, targetIndex)
  }

  indent(nodeId: NodeId): void {
    const tree = projectTree(this.doc)
    const node = this.assertLiveNode(tree, nodeId)
    if (node.parentId === null) {
      throw new DomainError('root-operation', 'Root нельзя сдвинуть вправо')
    }
    const siblings = tree.children.get(node.parentId) ?? []
    const index = siblings.indexOf(nodeId)
    if (index <= 0) {
      throw new DomainError('invalid-operation', 'Для indent нужен предыдущий sibling')
    }
    const newParentId = siblings[index - 1]
    this.move(nodeId, newParentId, tree.children.get(newParentId)?.length ?? 0)
  }

  outdent(nodeId: NodeId): void {
    const tree = projectTree(this.doc)
    const node = this.assertLiveNode(tree, nodeId)
    if (node.parentId === null || node.parentId === ROOT_ID) {
      throw new DomainError('invalid-operation', 'Узел уже находится на верхнем уровне')
    }
    const parent = this.assertLiveNode(tree, node.parentId)
    const grandParentId = parent.parentId ?? ROOT_ID
    const parentIndex = (tree.children.get(grandParentId) ?? []).indexOf(parent.id)
    this.move(nodeId, grandParentId, parentIndex + 1)
  }

  deleteSubtree(nodeId: NodeId): void {
    if (nodeId === ROOT_ID) {
      throw new DomainError('root-operation', 'Root нельзя удалить')
    }
    const tree = projectTree(this.doc)
    this.assertLiveNode(tree, nodeId)
    const ids = descendantsOf(tree, nodeId)
    const operationId = this.uniqueId('operation')
    const { deletions } = getStructures(this.doc)

    this.doc.transact(() => {
      for (const id of ids) {
        const record = this.requireRecord(id)
        const placement = readPlacement(record)
        if (placement !== null) this.removeOrderEntry(id, placement)
        deletions.set(`${operationId}:${id}`, id)
      }
    }, new CommandOrigin('delete-subtree', nodeId))
  }

  private createAt(parentId: NodeId, index: number, text: string): NodeId {
    const tree = projectTree(this.doc)
    this.assertLiveNode(tree, parentId)
    const siblings = tree.children.get(parentId) ?? []
    const targetIndex = Math.max(0, Math.min(index, siblings.length))
    const nextSiblingId = siblings[targetIndex]
    const nodeId = this.uniqueId('node')
    const placement: Placement = {
      parentId,
      placementId: this.uniqueId('placement'),
    }
    const { nodes, orders, deletions } = getStructures(this.doc)

    // Raw-записи живут независимо от undo создания, чтобы не потерять чужие правки.
    const birthMarker = `birth:${nodeId}`
    this.doc.transact(() => {
      nodes.set(nodeId, createNodeRecord(text, 'open', placement))
      orders.set(nodeId, new Y.Array<OrderEntry>())
      deletions.set(birthMarker, nodeId)
    }, 'seed-node')

    this.doc.transact(() => {
      this.materializeRecoveredSiblings(tree, parentId)
      const order = this.requireOrder(parentId)
      const rawIndex = nextSiblingId === undefined
        ? order.length
        : this.rawIndexForNode(order, nextSiblingId)
      deletions.delete(birthMarker)
      order.insert(rawIndex < 0 ? order.length : rawIndex, [{
        nodeId,
        placementId: placement.placementId,
      }])
    }, new CommandOrigin('create-node', nodeId))

    return nodeId
  }

  private assertLiveNode(tree: TreeProjection, nodeId: NodeId) {
    const node = tree.nodes.get(nodeId)
    if (node === undefined) {
      throw new DomainError('node-not-found', `Узел ${nodeId} не найден`)
    }
    return node
  }

  private materializeRecoveredSiblings(tree: TreeProjection, parentId: NodeId, excluding?: NodeId): void {
    const order = this.requireOrder(parentId)
    for (const id of tree.children.get(parentId) ?? []) {
      if (id === excluding || !tree.nodes.get(id)?.recovered) continue
      const record = this.requireRecord(id)
      const oldPlacement = readPlacement(record)
      if (oldPlacement) this.removeOrderEntry(id, oldPlacement)
      const placement = { parentId, placementId: this.uniqueId('placement') }
      order.push([{ nodeId: id, placementId: placement.placementId }])
      record.set('placement', placement)
    }
  }

  private requireRecord(nodeId: NodeId): NodeRecord {
    const { nodes, deletions } = getStructures(this.doc)
    const record = nodes.get(nodeId)
    if (record === undefined || record.get('deleted') === true || [...deletions.values()].includes(nodeId)) {
      throw new DomainError('node-not-found', `Узел ${nodeId} не найден`)
    }
    return record
  }

  private requireOrder(parentId: NodeId): Y.Array<OrderEntry> {
    const order = getStructures(this.doc).orders.get(parentId)
    if (order === undefined) {
      throw new DomainError('invalid-parent', `Для parent ${parentId} отсутствует порядок`)
    }
    return order
  }

  private removeOrderEntry(nodeId: NodeId, placement: Placement): void {
    const order = getStructures(this.doc).orders.get(placement.parentId)
    if (order === undefined) return
    const index = order.toArray().findIndex(entry => (
      entry.nodeId === nodeId && entry.placementId === placement.placementId
    ))
    if (index >= 0) order.delete(index, 1)
  }

  private rawIndexForNode(order: Y.Array<OrderEntry>, nodeId: NodeId): number {
    const record = getStructures(this.doc).nodes.get(nodeId)
    if (record === undefined) return -1
    const placement = readPlacement(record)
    if (placement === null) return -1
    return order.toArray().findIndex(entry => (
      entry.nodeId === nodeId && entry.placementId === placement.placementId
    ))
  }

  private uniqueId(kind: 'node' | 'placement' | 'operation'): string {
    const { nodes } = getStructures(this.doc)
    let id = this.createId()
    while (kind === 'node' && nodes.has(id)) id = this.createId()
    return id
  }
}
