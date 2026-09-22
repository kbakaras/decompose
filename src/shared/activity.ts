export const ACTIVITY_DOCUMENT = 'activity'
export const ACTIVITY_VERSION = 1

export type ActivityMode = 'diagram' | 'tracker' | 'file' | 'activity'

export interface ActivityResource {
  id: string
  label: string
  route: string
}

export interface ActivityConnection {
  connectionId: string
  mode: ActivityMode
  name: string | null
  resource?: ActivityResource
  owner?: boolean
}

export interface ActivitySnapshot {
  type: 'activity-snapshot'
  version: typeof ACTIVITY_VERSION
  connections: ActivityConnection[]
}

export function isActivitySnapshot(value: unknown): value is ActivitySnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<ActivitySnapshot>
  if (snapshot.type !== 'activity-snapshot' || snapshot.version !== ACTIVITY_VERSION || !Array.isArray(snapshot.connections)) return false
  return snapshot.connections.every(connection => {
    if (!connection || typeof connection !== 'object') return false
    if (typeof connection.connectionId !== 'string' || !['diagram', 'tracker', 'file', 'activity'].includes(connection.mode)) return false
    if (connection.name !== null && typeof connection.name !== 'string') return false
    if (connection.owner !== undefined && typeof connection.owner !== 'boolean') return false
    if (connection.mode === 'activity') return connection.resource === undefined
    const resource = connection.resource
    return !!resource && typeof resource.id === 'string' && typeof resource.label === 'string' && typeof resource.route === 'string'
  })
}
