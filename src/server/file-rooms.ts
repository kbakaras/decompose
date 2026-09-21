import { Server, type Connection, type Document } from '@hocuspocus/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import * as Y from 'yjs'
import { createUuid } from '../shared/uuid'
import { isDiagramId } from '../shared/diagrams'
import { getStructures, ROOT_ID, SCHEMA_VERSION } from '../domain'
import { DIAGRAM_FILE_LIMIT, snapshotDiagram, validateDiagramFile } from '../shared/diagram-file'

interface Room {
  name: string
  fileName?: string
  seed: Uint8Array
  secret: string
  saved: string
  owner?: Connection
  ownerSocket?: string
  active: boolean
  revision: number
  timer?: ReturnType<typeof setTimeout>
}

interface Registry { get(id: string): string | undefined; set(id: string, hash: string): unknown }
const secretHash = (secret: string) => createHash('sha256').update(secret).digest('hex')

/** Содержимое комнат живёт только в памяти; реестр хранит ID и проверку владельца. */
export class FileRooms {
  readonly rooms = new Map<string, Room>()
  readonly transport: Server
  constructor(private lifetime = 5 * 60 * 1000, private registry: Registry = new Map()) {
    this.transport = new Server({
      quiet: true, stopOnSignals: false, websocketOptions: { maxPayload: 8 * 1024 * 1024 },
      onAuthenticate: async ({ documentName, token, socketId, connectionConfig }) => {
        const room = this.room(documentName)
        if (!room) throw new Error('Файловая сессия завершена')
        const owner = token === room.secret
        if (owner && room.ownerSocket && room.ownerSocket !== socketId) throw new Error('Владелец уже подключён')
        if (owner) room.ownerSocket = socketId
        connectionConfig.readOnly = !owner && !room.active
        return { owner }
      },
      onLoadDocument: async ({ documentName, document }) => {
        const room = this.room(documentName)
        if (!room) throw new Error('Файловая сессия завершена')
        Y.applyUpdate(document, room.seed)
      },
      connected: async ({ documentName, connection, context }) => {
        const room = this.room(documentName)
        if (!room) { connection.close(); return }
        if (context.owner) { room.owner = connection; clearTimeout(room.timer) }
        this.publish(documentName)
      },
      beforeSync: async ({ documentName, connection, type }) => {
        const room = this.room(documentName)
        if (!room) throw new Error('Устаревшее поколение файловой сессии')
        connection.readOnly = connection !== room.owner && !room.active
        if (connection.readOnly && type !== 0) connection.sendStateless(JSON.stringify({ type: 'file-paused' }))
      },
      onChange: async ({ documentName, document }) => {
        const room = this.room(documentName)
        if (room) { room.seed = Y.encodeStateAsUpdate(document); room.revision++; this.publish(documentName) }
      },
      onStateless: async ({ documentName, connection, payload }) => {
        const room = this.room(documentName)
        if (!room || room.owner !== connection) return
        let message
        try { message = JSON.parse(payload) } catch { return }
        if (message.type === 'file-saved' && message.revision === room.revision) {
          room.active = true
          room.saved = JSON.stringify(snapshotDiagram(this.transport.hocuspocus.documents.get(documentName)!))
          if (typeof message.fileName === 'string' && message.fileName.length > 0 && message.fileName.length <= 1024
            && !/[\\/\u0000-\u001f\u007f]/.test(message.fileName)) room.fileName = message.fileName
        }
        else if (message.type === 'file-error') room.active = false
        else if (message.type === 'file-close') { this.end(documentName); return }
        this.publish(documentName)
      },
      onDisconnect: async ({ documentName, socketId }) => {
        const room = this.room(documentName)
        if (!room) return
        if (room.ownerSocket === socketId) {
          room.owner = undefined; room.ownerSocket = undefined; room.active = false
          clearTimeout(room.timer)
          room.timer = setTimeout(() => this.end(documentName), this.lifetime)
          room.timer.unref()
          this.publish(documentName)
        }
      },
      onAwarenessUpdate: async ({ document, connection, updated }) => {
        if (connection) for (const id of updated) document.getClients(connection).add(id)
      },
    })
  }

  create(state: unknown, id: unknown, authorization?: string) {
    const secret = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!isDiagramId(id) || secret.length !== 72
      || !isDiagramId(secret.slice(0, 36)) || !isDiagramId(secret.slice(36))) {
      return { status: 400, body: { error: 'Некорректный ID файла или секрет владельца.' } }
    }
    const registered = !!this.registry.get(id)
    if (registered && !this.authorized(id, authorization)) {
      return { status: 409, body: { error: 'Этот ID файла уже зарегистрирован другим владельцем.' } }
    }
    const previous = this.rooms.get(id)
    if (previous?.ownerSocket) return { status: 409, body: { error: 'Владелец уже подключён.' } }
    if (previous) return { status: 200, body: { id, secret, name: previous.name } }
    const room = this.decode(state, secret, registered ? `${id}~${createUuid()}` : id)
    if (!registered) this.registry.set(id, secretHash(secret))
    this.install(id, room)
    return { status: 201, body: { id, secret, name: room.name } }
  }

  private room(name: string) {
    const room = this.rooms.get(name.split('~')[0])
    return room?.name === name ? room : undefined
  }

  private authorized(id: string, authorization?: string) {
    const hash = this.registry.get(id)
    return !!hash && !!authorization?.startsWith('Bearer ') && timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(secretHash(authorization.slice(7)), 'hex'))
  }

  private decode(state: unknown, secret: string, name: string): Room {
    if (typeof state !== 'string' || state.length > DIAGRAM_FILE_LIMIT * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(state)) throw new Error('Некорректное состояние файла')
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, Buffer.from(state, 'base64'))
      const { meta, nodes } = getStructures(doc)
      if (meta.get('schemaVersion') !== SCHEMA_VERSION || !nodes.has(ROOT_ID)) throw new Error('Некорректное состояние файла')
      validateDiagramFile(snapshotDiagram(doc))
      return { name, seed: Y.encodeStateAsUpdate(doc), secret, saved: JSON.stringify(snapshotDiagram(doc)), active: false, revision: 0 }
    } finally { doc.destroy() }
  }

  private install(id: string, room: Room) {
    room.timer = setTimeout(() => this.end(id), this.lifetime)
    room.timer.unref()
    this.rooms.set(id, room)
  }

  lookup(id: string) {
    if (!this.registry.get(id)) return { status: 404, body: { error: 'Ссылка файловой сессии не найдена.' } }
    const room = this.rooms.get(id)
    return { status: 200, body: { name: room?.owner && room.active ? room.name : null, ...(room?.fileName ? { fileName: room.fileName } : {}) } }
  }

  restore(id: string, authorization: string | undefined, state: unknown, replace = false) {
    if (!this.authorized(id, authorization)) return { status: 404, body: { error: 'Ссылка или секрет владельца не найдены.' } }
    const previous = this.rooms.get(id)
    if (previous && (!replace || previous.ownerSocket)) return { status: 409, body: { error: 'Сессия уже запущена. Повтори открытие файла.' } }
    const room = this.decode(state, authorization!.slice(7), `${id}~${createUuid()}`)
    if (previous) this.end(id)
    this.install(id, room)
    return { status: 200, body: { id, name: room.name } }
  }

  resume(id: string, authorization?: string) {
    const room = this.rooms.get(id)
    if (!this.authorized(id, authorization)) return { status: 404, body: { error: 'Ссылка или секрет владельца не найдены.' } }
    if (!room) return { status: 410, body: { error: 'Ожидаем владельца файла.' } }
    if (room.ownerSocket) return { status: 409, body: { error: 'Владелец ещё подключён. Повтори открытие через несколько секунд.' } }
    return { status: 200, body: { name: room.name, state: Buffer.from(room.seed).toString('base64'), saved: room.saved } }
  }

  private publish(id: string) {
    const room = this.room(id)
    const doc = this.transport.hocuspocus.documents.get(id)
    if (!room || !doc) return
    for (const connection of doc.getConnections()) connection.readOnly = connection !== room.owner && !room.active
    doc.broadcastStateless(JSON.stringify({ type: 'file-state', active: room.active, revision: room.revision, fileName: room.fileName }))
  }

  private end(id: string) {
    id = id.split('~')[0]
    const room = this.rooms.get(id)
    if (!room) return
    clearTimeout(room.timer)
    this.rooms.delete(id)
    const doc: Document | undefined = this.transport.hocuspocus.documents.get(room.name)
    doc?.broadcastStateless(JSON.stringify({ type: 'file-ended' }))
    for (const connection of doc?.getConnections() ?? []) connection.close()
  }

  async close() {
    for (const id of this.rooms.keys()) this.end(id)
    await this.transport.destroy()
  }
}
