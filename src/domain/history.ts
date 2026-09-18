import * as Y from 'yjs'
import { getStructures, type NodeId } from './schema'
import { CommandOrigin } from './tree-commands'

const COMMAND = 'command'

/** Локальная история команд; remote updates и создание raw-записей не отслеживаются. */
export class DocumentHistory {
  private readonly manager: Y.UndoManager
  private readonly listeners = new Set<() => void>()

  constructor(doc: Y.Doc) {
    const { nodes, orders, deletions } = getStructures(doc)
    this.manager = new Y.UndoManager([nodes, orders, deletions], {
      trackedOrigins: new Set([CommandOrigin]),
      captureTimeout: 0,
      ignoreRemoteMapChanges: false,
      // Yjs сначала восстанавливает прежние значения, затем удаляет новые.
      // При конфликте восстановление Y.Map может быть пропущено: не даём
      // следующему удалению оставить узел без text/status/placement.
      deleteFilter: item => item.parent === deletions || item.parentSub === null,
    })
    this.manager.on('stack-item-added', ({ stackItem, origin }) => {
      if (origin instanceof CommandOrigin) stackItem.meta.set(COMMAND, origin)
      this.emit()
    })
    this.manager.on('stack-cleared', () => this.emit())
  }

  get canUndo(): boolean { return this.manager.canUndo() }
  get canRedo(): boolean { return this.manager.canRedo() }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  undo(): CommandOrigin | null { return this.apply('undo') }
  redo(): CommandOrigin | null { return this.apply('redo') }

  cancelCreation(nodeId: NodeId): boolean {
    const command = this.manager.undoStack.at(-1)?.meta.get(COMMAND) as CommandOrigin | undefined
    if (command?.kind !== 'create-node' || command.nodeId !== nodeId) return false
    this.undo()
    this.manager.clear(false, true)
    return true
  }

  destroy(): void {
    this.listeners.clear()
    this.manager.clear()
    this.manager.destroy()
  }

  private apply(direction: 'undo' | 'redo'): CommandOrigin | null {
    const item = this.manager[direction]()
    const command = item?.meta.get(COMMAND) as CommandOrigin | undefined
    // Yjs создаёт обратный шаг, но пользовательскую meta туда не копирует.
    if (command) {
      const opposite = direction === 'undo' ? this.manager.redoStack : this.manager.undoStack
      opposite.at(-1)?.meta.set(COMMAND, command)
    }
    this.emit()
    return command ?? null
  }

  private emit(): void { this.listeners.forEach(listener => listener()) }
}
