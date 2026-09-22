import { Server, type Connection, type Document, type Hocuspocus } from '@hocuspocus/server'
import { getStructures, readText, ROOT_ID } from '../domain'
import { ACTIVITY_DOCUMENT, ACTIVITY_VERSION, type ActivityConnection, type ActivitySnapshot } from '../shared/activity'
import { diagramTitle, diagramUrl, normalizeTitle } from '../shared/diagrams'
import { parseDocumentName } from '../shared/document-generation'
import { fileSessionUrl } from '../shared/diagram-route'
import { trackerLabel, trackerUrl } from '../shared/tracker'
import type { FileRooms } from './file-rooms'
import type { TrackerStorage } from './tracker-storage'
import { ConnectionIdentities } from './connection-identities'

const POLL_INTERVAL = 500

function participantName(document: Document, connection: Connection, identities: ConnectionIdentities): string | null {
  const states = document.awareness.getStates()
  for (const clientId of document.getClients(connection)) {
    const state = states.get(clientId)
    if (!state?.user || typeof state.user !== 'object') continue
    const value = (state.user as Record<string, unknown>).name
    if (typeof value !== 'string') continue
    const name = value.trim()
    if (name && [...name].length <= 80 && !/[\r\n]/.test(name)) return name
  }
  return identities.identity(connection)?.name ?? null
}

function connectionId(mode: string, resource: string, connection: Connection) {
  return `${mode}:${resource}:${connection.socketId}`
}

export class ActivityService {
  readonly transport: Server
  private timer?: ReturnType<typeof setInterval>
  private lastPayload = ''

  constructor(private collaboration: Hocuspocus, private storage: TrackerStorage, private fileRooms: FileRooms,
    private identities: ConnectionIdentities) {
    this.transport = new Server({
      quiet: true,
      stopOnSignals: false,
      websocketOptions: { maxPayload: 16 * 1024 },
      async onUpgrade({ request, socket }) {
        if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/activity-collaboration') {
          socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
          return Promise.reject()
        }
      },
      async onAuthenticate({ documentName }) {
        if (documentName !== ACTIVITY_DOCUMENT) throw new Error('Неизвестный документ мониторинга')
        return {}
      },
      async beforeSync({ connection }) { connection.readOnly = true },
      connected: async ({ connection }) => {
        connection.readOnly = true
        this.start()
        queueMicrotask(() => this.send(connection))
      },
      onAwarenessUpdate: async ({ document, connection, added, updated }) => {
        this.identities.capture(document, connection, [...added, ...updated])
        this.publish()
      },
      onStateless: async ({ connection, payload }) => {
        try {
          if (JSON.parse(payload).type === 'activity-request') this.send(connection)
        } catch { /* Игнорируем неизвестные stateless-сообщения. */ }
      },
      onDisconnect: async () => { queueMicrotask(() => this.afterDisconnect()) },
    })
  }

  private start() {
    if (this.timer) return
    this.timer = setInterval(() => this.publish(), POLL_INTERVAL)
    this.timer.unref()
    this.publish()
  }

  private afterDisconnect() {
    const document = this.transport.hocuspocus.documents.get(ACTIVITY_DOCUMENT)
    if ((document?.getConnectionsCount() ?? 0) > 0) { this.publish(); return }
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.lastPayload = ''
  }

  private snapshot(): ActivitySnapshot {
    const connections: ActivityConnection[] = []
    for (const [name, document] of this.collaboration.documents) {
      const parsed = parseDocumentName(name)
      if (!parsed || document.getConnectionsCount() === 0) continue
      const tracker = this.storage.trackerForDocument(parsed.id)
      const root = getStructures(document).nodes.get(ROOT_ID)
      const title = diagramTitle(root ? readText(root) : '', tracker?.trackerKey)
      const mode = tracker ? 'tracker' : 'diagram'
      const resource = {
        id: parsed.id,
        label: trackerLabel(title, tracker?.trackerKey),
        route: tracker ? trackerUrl(tracker.trackerKey) : diagramUrl(parsed.id),
      }
      for (const connection of document.getConnections()) connections.push({
        connectionId: connectionId(mode, parsed.id, connection), mode,
        name: participantName(document, connection, this.identities), resource,
      })
    }
    for (const room of this.fileRooms.activityRooms()) {
      const root = getStructures(room.document).nodes.get(ROOT_ID)
      const rootTitle = normalizeTitle(root ? readText(root) : '')
      const resource = {
        id: room.id,
        label: room.fileName || rootTitle || 'Файл',
        route: fileSessionUrl(room.id),
      }
      for (const connection of room.document.getConnections()) connections.push({
        connectionId: connectionId('file', room.id, connection), mode: 'file',
        name: participantName(room.document, connection, this.identities), resource,
        owner: connection.socketId === room.ownerSocketId,
      })
    }
    const activity = this.transport.hocuspocus.documents.get(ACTIVITY_DOCUMENT)
    for (const connection of activity?.getConnections() ?? []) connections.push({
      connectionId: connectionId('activity', ACTIVITY_DOCUMENT, connection), mode: 'activity',
      name: participantName(activity!, connection, this.identities),
    })
    connections.sort((left, right) => left.connectionId.localeCompare(right.connectionId))
    return { type: 'activity-snapshot', version: ACTIVITY_VERSION, connections }
  }

  private payload() { return JSON.stringify(this.snapshot()) }

  private send(connection: Connection) { connection.sendStateless(this.payload()) }

  private publish() {
    const document = this.transport.hocuspocus.documents.get(ACTIVITY_DOCUMENT)
    if (!document || document.getConnectionsCount() === 0) return
    const payload = this.payload()
    if (payload === this.lastPayload) return
    this.lastPayload = payload
    document.broadcastStateless(payload)
  }

  async close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.transport.destroy()
  }
}
