import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { DocumentHistory, getStructures, ROOT_ID, SCHEMA_VERSION, TreeCommands } from '../domain'

export interface Participant {
  clientId: number
  name: string
  color: string
  activeNode: string | null
  editingNode: string | null
}

export async function openSession() {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence('decompose:main:v1', doc)
  await persistence.whenSynced
  const history = new DocumentHistory(doc)
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const provider = new HocuspocusProvider({
    url: `${protocol}//${location.host}/collaboration`,
    name: 'main',
    document: doc,
  })
  const colors = ['#ad552b', '#457966', '#56649a', '#926581']
  const identity = {
    name: `Участник ${String(doc.clientID).slice(-4)}`,
    color: colors[doc.clientID % colors.length],
  }
  provider.setAwarenessField('user', identity)
  const offline = () => provider.disconnect()
  const online = () => { void provider.connect() }
  window.addEventListener('offline', offline)
  window.addEventListener('online', online)
  if (!navigator.onLine) offline()

  return {
    doc, provider, persistence, identity, history,
    commands: new TreeCommands(doc),
    ready: () => {
      const { meta, nodes } = getStructures(doc)
      return meta.get('schemaVersion') === SCHEMA_VERSION && nodes.has(ROOT_ID)
    },
    participants(): Participant[] {
      if (!navigator.onLine || provider.configuration.websocketProvider.status !== 'connected') return []
      return [...(provider.awareness?.getStates().entries() ?? [])].map(([clientId, state]) => ({
        clientId,
        name: typeof state.user?.name === 'string' ? state.user.name : 'Участник',
        color: typeof state.user?.color === 'string' ? state.user.color : '#777',
        activeNode: typeof state.activeNode === 'string' ? state.activeNode : null,
        editingNode: typeof state.editingNode === 'string' ? state.editingNode : null,
      }))
    },
    async destroy() {
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
      provider.destroy()
      history.destroy()
      await persistence.destroy()
      doc.destroy()
    },
  }
}

export type Session = Awaited<ReturnType<typeof openSession>>
