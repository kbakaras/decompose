import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Background, BackgroundVariant, getNodesBounds, getViewportForBounds, ReactFlow, ReactFlowProvider, useReactFlow, type Edge } from '@xyflow/react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { ACTIVITY_DOCUMENT, isActivitySnapshot, type ActivityMode, type ActivitySnapshot } from '../shared/activity'
import { appBaseUrl } from './app-url'
import { collaborationUrl } from './collaboration-url'
import { browserIdentity, subscribeIdentity } from './identity'
import { ActivityCard, type ActivityFlowCard } from './ActivityCard'
import { layoutActivity } from './activity-layout'
import { NODE_MIN_HEIGHT, NODE_WIDTH } from './layout'

const nodeTypes = { activity: ActivityCard }
const modeOrder: ActivityMode[] = ['diagram', 'tracker', 'file', 'activity']
const modeLabels: Record<ActivityMode, string> = {
  diagram: 'Схемы', tracker: 'Задачи', file: 'Файловые сессии', activity: 'Мониторинг',
}

interface ActivityNode {
  id: string
  label: string
  kind: 'root' | 'mode' | 'resource' | 'participant'
  parentId: string | null
  route?: string
  owner: boolean
  connectionId?: string
}

function activityTree(snapshot: ActivitySnapshot) {
  const rootId = 'activity-root'
  const nodes = new Map<string, ActivityNode>()
  const children = new Map<string, string[]>()
  const append = (node: ActivityNode) => {
    nodes.set(node.id, node)
    children.set(node.id, [])
    if (node.parentId) children.get(node.parentId)!.push(node.id)
  }
  append({ id: rootId, label: 'Активные подключения', kind: 'root', parentId: null, owner: false })
  const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })
  const compareConnections = (left: ActivitySnapshot['connections'][number], right: ActivitySnapshot['connections'][number]) => {
    if (left.name === null && right.name !== null) return 1
    if (left.name !== null && right.name === null) return -1
    return collator.compare(left.name ?? '', right.name ?? '') || left.connectionId.localeCompare(right.connectionId)
  }
  for (const mode of modeOrder) {
    const connections = snapshot.connections.filter(connection => connection.mode === mode)
    if (!connections.length) continue
    const modeId = `mode:${mode}`
    append({ id: modeId, label: modeLabels[mode], kind: 'mode', parentId: rootId, owner: false })
    if (mode === 'activity') {
      connections.sort(compareConnections)
      for (const connection of connections) append({
        id: `connection:${connection.connectionId}`, label: connection.name ?? 'Анонимный пользователь',
        kind: 'participant', parentId: modeId, owner: false, connectionId: connection.connectionId,
      })
      continue
    }
    const resources = new Map<string, typeof connections>()
    for (const connection of connections) {
      const id = connection.resource!.id
      const list = resources.get(id) ?? []
      list.push(connection)
      resources.set(id, list)
    }
    for (const [resourceId, members] of [...resources].sort((left, right) =>
      collator.compare(left[1][0].resource!.label, right[1][0].resource!.label) || left[0].localeCompare(right[0]))) {
      const resource = members[0].resource!
      const nodeId = `resource:${mode}:${resourceId}`
      append({ id: nodeId, label: resource.label, route: resource.route, kind: 'resource', parentId: modeId, owner: false })
      members.sort(compareConnections)
      for (const connection of members) append({
        id: `connection:${connection.connectionId}`, label: connection.name ?? 'Анонимный пользователь',
        kind: 'participant', parentId: nodeId, owner: connection.owner === true, connectionId: connection.connectionId,
      })
    }
  }
  return { rootId, nodes, children }
}

export function ActivityPage({ header, navigate, switching }: { header: HTMLElement; navigate: (href: string) => Promise<void>; switching: boolean }) {
  return <ReactFlowProvider><ActivityWorkspace header={header} navigate={navigate} switching={switching} /></ReactFlowProvider>
}

function ActivityWorkspace({ header, navigate, switching }: { header: HTMLElement; navigate: (href: string) => Promise<void>; switching: boolean }) {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [showStatus, setShowStatus] = useState(false)
  const [heights, setHeights] = useState(new Map<string, number>())
  const [positions, setPositions] = useState(new Map<string, { x: number; y: number }>())
  const [layoutReady, setLayoutReady] = useState(false)
  const initialFit = useRef(false)
  const canvas = useRef<HTMLElement>(null)
  const flow = useReactFlow<ActivityFlowCard>()
  const tree = useMemo(() => snapshot ? activityTree(snapshot) : null, [snapshot])

  useEffect(() => {
    document.title = 'Активные подключения — дерево·дел'
    const doc = new Y.Doc()
    let provider: HocuspocusProvider
    const publishIdentity = () => provider.awareness?.setLocalState({ user: browserIdentity() })
    provider = new HocuspocusProvider({
      url: collaborationUrl(appBaseUrl, 'activity-collaboration'), name: ACTIVITY_DOCUMENT, document: doc,
      onStatus: ({ status }) => {
        const online = status === 'connected'
        setConnected(online)
        if (!online) setSnapshot(null)
      },
      onSynced: ({ state }) => { if (state) provider.sendStateless(JSON.stringify({ type: 'activity-request' })) },
      onStateless: ({ payload }) => {
        try {
          const value: unknown = JSON.parse(payload)
          if (isActivitySnapshot(value)) setSnapshot(value)
        } catch { /* Игнорируем повреждённый снимок. */ }
      },
      onAuthenticationFailed: () => { setConnected(false); setSnapshot(null) },
    })
    const unsubscribe = subscribeIdentity(publishIdentity)
    const publishVisibleIdentity = () => { if (document.visibilityState === 'visible') publishIdentity() }
    document.addEventListener('visibilitychange', publishVisibleIdentity)
    publishIdentity()
    return () => { document.removeEventListener('visibilitychange', publishVisibleIdentity); unsubscribe(); provider.destroy(); doc.destroy() }
  }, [])

  useEffect(() => {
    setShowStatus(false)
    if (snapshot) return
    initialFit.current = false
    setPositions(new Map())
    setLayoutReady(false)
    const timer = window.setTimeout(() => setShowStatus(true), 400)
    return () => window.clearTimeout(timer)
  }, [snapshot, connected])

  const measure = useCallback((id: string, height: number) => {
    setHeights(old => old.get(id) === height ? old : new Map(old).set(id, height))
  }, [])

  useEffect(() => {
    if (!tree || !flow.viewportInitialized || [...tree.nodes.keys()].some(id => !heights.has(id))) return
    let stale = false
    layoutActivity(tree.rootId, tree.children, heights).then(async next => {
      if (stale) return
      if (!initialFit.current) {
        const element = canvas.current
        if (!element) return
        const bounds = getNodesBounds([...next].map(([id, position]) => ({
          id, position, data: {}, width: NODE_WIDTH, height: heights.get(id) ?? NODE_MIN_HEIGHT,
        })))
        const viewport = getViewportForBounds(bounds, element.clientWidth, element.clientHeight, 0.2, 1, 0.25)
        const applied = await flow.setViewport(viewport, { duration: 0 })
        if (stale || !applied) return
        initialFit.current = true
      }
      setPositions(next)
      setLayoutReady(true)
    }).catch(() => { if (!stale) setLayoutReady(false) })
    return () => { stale = true }
  }, [tree, heights, flow])

  const nodes: ActivityFlowCard[] = tree ? [...tree.nodes.values()].map(node => ({
    id: node.id, type: 'activity', position: positions.get(node.id) ?? { x: 0, y: 0 },
    style: { opacity: positions.has(node.id) ? 1 : 0, pointerEvents: positions.has(node.id) ? 'auto' : 'none' },
    measured: { width: NODE_WIDTH, height: heights.get(node.id) ?? NODE_MIN_HEIGHT },
    draggable: false,
    data: {
      label: node.label, kind: node.kind, route: node.route, owner: node.owner,
      hasParent: node.parentId !== null, hasChildren: (tree.children.get(node.id)?.length ?? 0) > 0,
      positioned: positions.has(node.id), connectionId: node.connectionId,
      onMeasure: measure, onNavigate: route => { void navigate(route) },
    },
  })) : []
  const edges: Edge[] = tree ? [...tree.nodes.values()].flatMap(node => node.parentId ? [{
    id: `edge:${node.id}`, source: node.parentId, target: node.id, type: 'smoothstep',
    hidden: !positions.has(node.id) || !positions.has(node.parentId),
    style: { stroke: '#bdb8aa', strokeWidth: 1.5 },
  }] : []) : []

  return <>
    {createPortal(<p className="document-title activity-title">Активные подключения</p>, header)}
    <main ref={canvas} className="canvas activity-canvas" aria-label="Мониторинг активных подключений" inert={switching}
      data-ready={String(!!snapshot && layoutReady)}>
      {tree && <ReactFlow<ActivityFlowCard> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        style={{ opacity: layoutReady ? 1 : 0, pointerEvents: layoutReady ? 'auto' : 'none' }}
        nodesConnectable={false} nodesDraggable={false} nodesFocusable={false} edgesFocusable={false}
        zoomOnDoubleClick={false} disableKeyboardA11y deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        minZoom={0.2} maxZoom={1.6} proOptions={{ hideAttribution: false }}>
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#d9d5c9" />
      </ReactFlow>}
      {!snapshot && showStatus && <div className="loading" role="status">{connected ? 'Получаем активные подключения…' : 'Нет соединения с сервером.'}</div>}
    </main>
  </>
}
