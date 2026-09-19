import type { Connection, Document, Hocuspocus, onStatelessPayload } from '@hocuspocus/server'
import * as Y from 'yjs'
import { createUuid } from '../shared/uuid'
import { isDiagramId } from '../shared/diagrams'
import { documentName } from '../shared/document-generation'
import { serializeDiagram, validateDiagramFile, type DiagramFile } from '../shared/diagram-file'
import { createImportedDocument } from '../domain'
import type { TrackerStorage } from './tracker-storage'

export class ReplacementError extends Error { constructor(message: string, public status = 409) { super(message) } }
type Kind = 'replace' | 'delete' | 'transfer'
interface Barrier {
  id: string; generation: number; name: string; operation: string; kind: Kind
  doc?: Document
  members: Set<Connection>; pending: Set<Connection>
  ready: Promise<void>; done: () => void; fail: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  prepared?: { operation: string; file: DiagramFile; expiresAt: number }
}

/** Одна блокировка для всех операций, меняющих жизненный цикл документа. */
export class Replacements {
  private locks = new Map<string, Barrier>()
  constructor(private storage: TrackerStorage, private collaboration: Hocuspocus, private timeout = 15000, private transferTimeout = 60000) {}
  locked(name: string) { return this.locks.has(name) }
  canWrite(name: string, connection: Connection) { const lock = this.locks.get(name); return !lock || lock.pending.has(connection) }
  joined(name: string, connection: Connection) {
    const lock = this.locks.get(name)
    if (lock) { connection.readOnly = true; connection.sendStateless(JSON.stringify({ type: 'replace-prepare', operation: lock.operation, kind: lock.kind })) }
  }
  acknowledge({ documentName: name, connection, payload }: onStatelessPayload) {
    let message
    try { message = JSON.parse(payload) } catch { return }
    const lock = this.locks.get(name)
    if (!lock || message.type !== 'replace-ready' || message.operation !== lock.operation || !lock.members.has(connection)) return
    connection.readOnly = true; lock.pending.delete(connection)
    if (!lock.pending.size) lock.done()
  }
  disconnected(name: string) {
    const lock = this.locks.get(name)
    if (lock) this.cancel(lock, 'Участник отключился. Операция отменена.')
  }
  close() { for (const lock of this.locks.values()) this.cancel(lock, 'Сервер останавливается. Операция отменена.') }

  private finish(lock: Barrier) { clearTimeout(lock.timer); this.locks.delete(lock.name) }
  private cancel(lock: Barrier, message = 'Операция отменена.') {
    if (this.locks.get(lock.name) !== lock) return
    this.finish(lock)
    for (const connection of lock.members) connection.readOnly = false
    lock.doc?.broadcastStateless(JSON.stringify({ type: 'replace-cancelled', operation: lock.operation }))
    lock.fail(new ReplacementError(message))
  }
  private async begin(id: string, generation: number, operation: string, kind: Kind) {
    if (!Number.isSafeInteger(generation) || generation < 0 || !isDiagramId(operation) || operation === 'main') throw new ReplacementError('Некорректные параметры операции', 400)
    if (kind !== 'replace' && id === 'main') throw new ReplacementError('Основную схему удалять нельзя.')
    const name = documentName(id, generation)
    if (!this.storage.accepts(name)) throw new ReplacementError('Схема не найдена, удалена или уже заменена.')
    const previous = this.locks.get(name)
    if (previous) {
      if (previous.operation !== operation || previous.kind !== kind) throw new ReplacementError('Другая операция уже выполняется.')
      await previous.ready
      if (this.locks.get(name) !== previous) throw new ReplacementError('Операция отменена.')
      return previous
    }
    const doc = this.collaboration.documents.get(name), members = new Set(doc?.getConnections() ?? [])
    let done!: () => void, fail!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { done = resolve; fail = reject })
    const lock: Barrier = { id, generation, name, operation, kind, doc, members, pending: new Set(members), ready, done, fail,
      timer: setTimeout(() => this.cancel(lock, 'Не все вкладки подтвердили синхронизацию за 15 секунд. Операция отменена.'), this.timeout) }
    this.locks.set(name, lock)
    doc?.broadcastStateless(JSON.stringify({ type: 'replace-prepare', operation, kind }))
    if (!members.size) done()
    await ready
    if (this.locks.get(name) !== lock) throw new ReplacementError('Операция отменена.')
    clearTimeout(lock.timer)
    return lock
  }

  async replace(id: string, generation: number, value: unknown) {
    const replacement = createImportedDocument(validateDiagramFile(value))
    let lock: Barrier | undefined
    try {
      lock = await this.begin(id, generation, createUuid(), 'replace')
      const next = this.storage.replace(id, generation, replacement)
      lock.doc?.broadcastStateless(JSON.stringify({ type: 'replaced', generation: next }))
      this.finish(lock)
      return { generation: next }
    } catch (error) { if (lock) this.cancel(lock); throw error }
    finally { replacement.destroy() }
  }

  private completeRemoval(lock: Barrier) {
    const result = this.storage.remove(lock.id, lock.generation, lock.operation)
    this.finish(lock)
    lock.doc?.broadcastStateless(JSON.stringify({ type: 'deleted', ...result }))
    return result
  }
  async remove(id: string, generation: number, operation: string) {
    const deleted = this.storage.deleted(id)
    if (deleted && deleted.operation === operation) return deleted
    const lock = await this.begin(id, generation, operation, 'delete')
    try { return this.completeRemoval(lock) } catch (error) { this.cancel(lock); throw error }
  }
  async prepareTransfer(id: string, generation: number, operation: string) {
    const lock = await this.begin(id, generation, operation, 'transfer')
    if (lock.prepared) return lock.prepared
    const doc = lock.doc ?? new Y.Doc()
    try {
      if (!lock.doc) {
        const row = this.storage.db!.prepare('SELECT data FROM documents WHERE name = ?').get(id) as { data: Buffer }
        Y.applyUpdate(doc, row.data)
      }
      const file: DiagramFile = JSON.parse(serializeDiagram(doc))
      lock.prepared = { operation, file, expiresAt: Date.now() + this.transferTimeout }
      lock.timer = setTimeout(() => this.cancel(lock, 'Время записи файла истекло.'), this.transferTimeout)
      return lock.prepared
    } catch (error) { this.cancel(lock); throw error }
    finally { if (!lock.doc) doc.destroy() }
  }
  commitTransfer(id: string, operation: string) {
    const deleted = this.storage.deleted(id)
    if (deleted && deleted.operation === operation) return deleted
    const lock = this.locks.get(this.storage.currentName(id))
    if (!lock || lock.kind !== 'transfer' || lock.operation !== operation || !lock.prepared || Date.now() >= lock.prepared.expiresAt) throw new ReplacementError('Перенос отменён или истёк. Файл остаётся копией; схема не удалена.')
    try { return this.completeRemoval(lock) } catch (error) { this.cancel(lock); throw error }
  }
  abortTransfer(id: string, operation: string) {
    const lock = this.locks.get(this.storage.currentName(id))
    if (lock?.kind === 'transfer' && lock.operation === operation) this.cancel(lock)
  }
}
