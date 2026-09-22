import type { Connection, Document } from '@hocuspocus/server'
import {
  PARTICIPANT_ROSTER_VERSION,
  type ParticipantRoster,
  type ParticipantRosterMember,
} from '../shared/participant-roster'

export interface ConnectionIdentity {
  userId: string
  name: string | null
  color: string
}

function readIdentity(state: unknown): ConnectionIdentity | undefined {
  if (!state || typeof state !== 'object') return undefined
  const user = (state as Record<string, unknown>).user
  if (!user || typeof user !== 'object') return undefined
  const value = user as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 200) return undefined
  let name: string | null = null
  if (value.name !== null && value.name !== undefined) {
    if (typeof value.name !== 'string') return undefined
    name = value.name.trim()
    if (!name || [...name].length > 80 || /[\r\n]/.test(name)) return undefined
  }
  const color = typeof value.color === 'string' && value.color.length > 0 && value.color.length <= 64
    && !/[\u0000-\u001f\u007f]/.test(value.color) ? value.color : '#777'
  return { userId: value.id, name, color }
}

function sameIdentity(left: ConnectionIdentity | undefined, right: ConnectionIdentity) {
  return left?.userId === right.userId && left.name === right.name && left.color === right.color
}

/** Идентичность живёт не дольше WebSocket и переживает истечение его Awareness-state. */
export class ConnectionIdentities {
  private identities = new WeakMap<Connection, ConnectionIdentity>()
  private lastPayload = new WeakMap<Document, string>()

  identity(connection: Connection) { return this.identities.get(connection) }

  capture(document: Document, connection: Connection | undefined, clientIds: Iterable<number>) {
    if (!connection) return false
    let changed = false
    const clients = document.getClients(connection)
    for (const clientId of clientIds) {
      clients.add(clientId)
      const identity = readIdentity(document.awareness.getStates().get(clientId))
      if (identity && !sameIdentity(this.identities.get(connection), identity)) {
        this.identities.set(connection, identity)
        changed = true
      }
    }
    return changed
  }

  roster(document: Document): ParticipantRoster {
    const participants: ParticipantRosterMember[] = document.getConnections().flatMap(connection => {
      const identity = this.identities.get(connection)
      return identity ? [{ connectionId: connection.socketId, ...identity }] : []
    })
    participants.sort((left, right) => left.connectionId.localeCompare(right.connectionId))
    return { type: 'participant-roster', version: PARTICIPANT_ROSTER_VERSION, participants }
  }

  send(connection: Connection) {
    const payload = JSON.stringify(this.roster(connection.document))
    this.lastPayload.set(connection.document, payload)
    connection.sendStateless(payload)
  }

  publish(document: Document) {
    if (document.getConnectionsCount() === 0) return
    const payload = JSON.stringify(this.roster(document))
    if (this.lastPayload.get(document) === payload) return
    this.lastPayload.set(document, payload)
    document.broadcastStateless(payload)
  }
}
