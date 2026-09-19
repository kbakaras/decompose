import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { DocumentHistory, getStructures, ROOT_ID, SCHEMA_VERSION, TreeCommands } from '../domain'
import { browserIdentity, refreshIdentity, subscribeIdentity } from './identity'
import { readParticipants, type Participant } from './presence'
import type { TrackerSummary } from '../shared/tracker'
import type { FileAutosave } from './diagram-file'
import type { DeletedDiagram } from './deleted-diagrams'
import type { FileRecord } from './file-records'

export class Session {
  readonly history: DocumentHistory
  readonly commands: TreeCommands
  provider?: HocuspocusProvider
  file?: FileAutosave
  fileRecord?: FileRecord
  fileUrl?: string
  fileName = ''
  generation = 0
  blocked = false
  outdated = false
  reloadRequested = false
  ended = false
  deleted = false
  retire?: (value: DeletedDiagram) => Promise<void>
  message = ''
  fileNotice = ''
  waitingForOwner = false
  roomUrl = ''
  fileRevision = 0
  prepare?: () => void
  roomClose?: () => void
  persist: () => Promise<void> = async () => {}
  release: () => Promise<void> = async () => {}
  private closing?: Promise<void>
  private listeners = new Set<() => void>()
  private hidden = false
  private selection = { activeNode: null as string | null, editingNode: null as string | null }
  private unsubscribeIdentity: () => void
  constructor(readonly id: string, readonly doc: Y.Doc, readonly source: 'system' | 'file' | 'guest' = 'system', public tracker?: TrackerSummary) {
    browserIdentity(); this.history = new DocumentHistory(doc); this.commands = new TreeCommands(doc)
    this.unsubscribeIdentity = subscribeIdentity(this.publishIdentity)
    window.addEventListener('pagehide', this.pagehide, true); window.addEventListener('pageshow', this.pageshow)
    window.addEventListener('offline', this.offline); window.addEventListener('online', this.online)
    window.addEventListener('beforeunload', this.beforeUnload)
  }
  get identity() { return browserIdentity() }
  get closed() { return !!this.closing }
  get connected() { return navigator.onLine && this.provider?.configuration.websocketProvider.status === 'connected' }
  get canEdit() { return !this.blocked && !this.deleted && !this.outdated && !this.ended && (this.source !== 'guest' || this.connected) }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit = () => { this.listeners.forEach(listener => listener()) }
  attach(provider: HocuspocusProvider) {
    this.provider = provider; provider.on('status', this.emit); provider.on('synced', this.emit); provider.awareness?.on('change', this.emit)
    this.publishIdentity(); if (!navigator.onLine) provider.disconnect(); this.emit()
  }
  private publishIdentity = () => {
    if (!this.closing && !this.hidden) this.provider?.awareness?.setLocalState({ user: this.identity,
      activeNode: this.identity.name ? this.selection.activeNode : null, editingNode: this.identity.name ? this.selection.editingNode : null })
    this.emit()
  }
  setPresence(field: 'activeNode' | 'editingNode', value: string | null) { this.selection[field] = value; this.publishIdentity() }
  participants(): Participant[] { return this.connected ? readParticipants(this.provider?.awareness?.getStates().entries() ?? []) : [] }
  ready() { const { meta, nodes } = getStructures(this.doc); return meta.get('schemaVersion') === SCHEMA_VERSION && nodes.has(ROOT_ID) }
  async whenReady(signal: AbortSignal) {
    signal.throwIfAborted(); if (this.ready() || this.waitingForOwner) return
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); this.doc.off('update', changed); signal.removeEventListener('abort', aborted); this.provider?.off('authenticationFailed', denied)
        if (error) reject(error); else resolve()
      }
      const changed = () => { if (this.ready()) finish() }
      const aborted = () => finish(new DOMException('Переход отменён', 'AbortError'))
      const denied = () => finish(new Error('Сессия недоступна или завершена.'))
      const timer = setTimeout(() => finish(new Error('Не удалось загрузить схему. Проверь соединение.')), 10000)
      this.doc.on('update', changed); signal.addEventListener('abort', aborted, { once: true }); this.provider?.on('authenticationFailed', denied); changed()
    })
  }
  async synced(timeout = 10000) {
    const provider = this.provider; if (!provider) return
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); provider.off('unsyncedChanges', check); provider.off('status', check); if (error) reject(error); else resolve() }
      const check = () => { if (this.connected && !provider.hasUnsyncedChanges) finish() }
      const timer = setTimeout(() => finish(new Error('Не удалось подтвердить синхронизацию.')), timeout)
      provider.on('unsyncedChanges', check); provider.on('status', check); check()
    })
  }
  flush = async () => { await this.persist(); await this.file?.save() }
  private offline = () => { this.provider?.disconnect(); this.emit() }
  private online = () => { if (!this.closing && !this.hidden && !this.deleted && !this.outdated && !this.ended) void this.provider?.connect(); this.emit() }
  private pagehide = () => { this.hidden = true; this.provider?.awareness?.setLocalState(null); this.provider?.disconnect() }
  private pageshow = (event: PageTransitionEvent) => { if (event.persisted && !this.closing) { refreshIdentity(); this.hidden = false; this.publishIdentity(); this.online() } }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    // Draft ещё не попал в Y.Doc: завершаем его до проверки несохранённого файла.
    if (this.file) this.prepare?.()
    if (this.file?.dirty || this.file?.saving) { event.preventDefault(); event.returnValue = '' }
  }
  destroy() {
    if (this.closing) return this.closing
    this.unsubscribeIdentity()
    window.removeEventListener('pagehide', this.pagehide, true); window.removeEventListener('pageshow', this.pageshow)
    window.removeEventListener('offline', this.offline); window.removeEventListener('online', this.online); window.removeEventListener('beforeunload', this.beforeUnload)
    this.roomClose?.(); this.provider?.destroy(); this.file?.destroy()
    this.closing = (async () => { try { await this.persist(); await this.file?.waitForWrite() } finally { await this.release(); this.history.destroy(); this.doc.destroy(); this.listeners.clear() } })()
    return this.closing
  }
}
