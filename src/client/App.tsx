import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, ViewportPortal, getNodesBounds, getViewportForBounds, useReactFlow, type Edge } from '@xyflow/react'
import { DomainError, ROOT_ID, projectTree, normalizeText, readTextAlign } from '../domain'
import { diagramTitle } from '../shared/diagrams'
import { trackerLabel } from '../shared/tracker'
import type { Session } from './session'
import { Cell, type EditState, type FlowCell } from './Cell'
import { DiagramPicker } from './DiagramPicker'
import { focusAfterRemoval, navigate } from './interaction'
import { layoutTree, NODE_WIDTH, NODE_MIN_HEIGHT } from './layout'
import { beginSiblingDrag, isSiblingDragValid, siblingDropTarget, type DragPreview } from './sibling-drag'
import { browserIdentity, initials, subscribeIdentity } from './identity'
import { summarizeParticipants } from './presence'
import { FileActions, type FileActionsHandle } from './FileActions'
import { downloadDiagram, pickWritableFile } from './diagram-file'
import { shareFileSession, type OpenLocalFile } from './file-session'
import { StorageActions, type StorageAction } from './StorageActions'
import { FileIndicator } from './FileIndicator'

const nodeTypes = { cell: Cell }

interface WorkspaceProps {
  session: Session
  header: HTMLElement
  switching: boolean
  navigate: (url: string) => Promise<void>
  registerBeforeLeave: (callback: () => void) => () => void
  requestIdentity: () => Promise<boolean>
  editIdentity: () => void
  openLocal: OpenLocalFile
  reload: () => Promise<void>
}

export function App(props: WorkspaceProps) {
  return <ReactFlowProvider><Workspace {...props} /></ReactFlowProvider>
}

function Workspace({ session, header, switching, navigate: navigateToDiagram, registerBeforeLeave, requestIdentity, editIdentity, openLocal, reload }: WorkspaceProps) {
  const identity = useSyncExternalStore(subscribeIdentity, browserIdentity)
  const actionEpoch = useRef(0)
  useEffect(() => () => { actionEpoch.current++ }, [])
  const withIdentity = useCallback((operation: () => void) => {
    if (!session.canEdit) return
    if (session.identity.name) { operation(); return }
    const epoch = actionEpoch.current
    void requestIdentity().then(accepted => {
      if (accepted && epoch === actionEpoch.current && session.identity.name && session.canEdit) operation()
    })
  }, [session, requestIdentity])
  const [, redraw] = useState(0)
  const [revision, setRevision] = useState(0)
  const [active, setActive] = useState(ROOT_ID)
  const [edit, setEdit] = useState<EditState | null>(null)
  const editRef = useRef<EditState | null>(null)
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const fileActions = useRef<FileActionsHandle>(null)
  const pickingFile = useRef(false)
  const [storageMode, setStorageMode] = useState<StorageAction | null>(null)
  const [sharing, setSharing] = useState(false)
  const [shareLink, setShareLink] = useState('')
  const shareDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (shareLink) shareDialog.current?.showModal(); else shareDialog.current?.close() }, [shareLink])
  const actionsContainer = useRef<HTMLDivElement>(null)
  const [heights, setHeights] = useState(new Map<string, number>())
  const [positions, setPositions] = useState(new Map<string, { x: number; y: number }>())
  const [layoutReady, setLayoutReady] = useState(false)
  const initialFit = useRef(false)
  const lastFocusTarget = useRef<{ id: string; x: number; y: number; height: number } | null>(null)
  const [drag, setDrag] = useState<DragPreview | null>(null)
  const dragRef = useRef<DragPreview | null>(null)
  const updateDrag = useCallback((next: DragPreview | null) => {
    dragRef.current = next
    setDrag(next)
  }, [])
  const canvas = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLButtonElement>(null)
  const flow = useReactFlow<FlowCell>()
  const tree = useMemo(() => projectTree(session.doc), [session, revision])
  const previous = useRef(tree)
  const ready = session.ready()
  const participants = session.participants()
  const presence = summarizeParticipants(participants, identity)
  const avatars = presence.named.filter(person => person.id !== identity.id)
  const connected = !!session.connected
  const others = participants.filter(person => person.name && person.clientId !== session.doc.clientID)
  const documentTitle = diagramTitle(tree.nodes.get(ROOT_ID)?.text ?? '', session.tracker?.trackerKey)
  const textAlign = readTextAlign(session.doc)
  useEffect(() => { document.title = `${trackerLabel(documentTitle, session.tracker?.trackerKey)} — дерево·дел` }, [documentTitle, session.tracker])

  useEffect(() => {
    if (!actionsOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!actionsContainer.current?.contains(event.target as Node)) setActionsOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [actionsOpen])

  useEffect(() => {
    const changed = () => setRevision(value => value + 1)
    const refresh = () => redraw(value => value + 1)
    const unsubscribeHistory = session.history.subscribe(refresh)
    session.doc.on('update', changed)
    const unsubscribeSession = session.subscribe(refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    changed()
    return () => {
      unsubscribeHistory()
      session.doc.off('update', changed)
      unsubscribeSession()
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', refresh)
    }
  }, [session])

  const updateEdit = useCallback((next: EditState | null) => {
    const previousId = editRef.current?.id ?? null
    editRef.current = next
    setEdit(next)
    if (previousId !== (next?.id ?? null)) session.setPresence('editingNode', next?.id ?? null)
  }, [session])
  const focusCanvas = useCallback(() => {
    // Закрытие одного диалога не должно отбирать фокус у следующего.
    if (!editRef.current && !document.querySelector('dialog[open]')) canvas.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    session.setPresence('activeNode', active)
    if (ready && !switching && !editRef.current) focusCanvas()
  }, [active, ready, switching, session, focusCanvas])
  useEffect(() => {
    if (!tree.nodes.has(active)) {
      setActive(focusAfterRemoval(previous.current, tree, active))
      updateEdit(null)
      setMessage('Клеточка больше не видна. Выбран ближайший узел.')
    }
    previous.current = tree
  }, [tree, active, updateEdit])

  const measure = useCallback((id: string, height: number) => {
    setHeights(old => old.get(id) === height ? old : new Map(old).set(id, height))
  }, [])
  useEffect(() => {
    if (drag?.phase === 'dragging' && !isSiblingDragValid(tree, drag.snapshot)) {
      updateDrag(null)
      setNotice('Структура изменилась другим участником. Повтори перетаскивание.')
    }
  }, [tree, drag, updateDrag])
  useEffect(() => {
    if (!ready || !flow.viewportInitialized || drag?.phase === 'dragging' || [...tree.nodes.keys()].some(id => !heights.has(id))) return
    let stale = false
    layoutTree(tree, heights).then(async next => {
      if (stale) return
      if (!initialFit.current) {
        const element = canvas.current
        if (!element) return
        // Используем готовую раскладку, а не ещё не обновлённые nodes в React Flow.
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
      if (dragRef.current?.phase === 'settling') updateDrag(null)
    }).catch(error => {
      if (!stale) {
        if (dragRef.current?.phase === 'settling') updateDrag(null)
        setNotice(`Не удалось рассчитать схему: ${String(error)}`)
      }
    })
    return () => { stale = true }
  }, [tree, heights, ready, drag?.phase, updateDrag, flow])
  useEffect(() => {
    if (!layoutReady || drag) return
    const position = positions.get(active)
    const bounds = canvas.current?.getBoundingClientRect()
    if (!position || !bounds) return
    const target = { id: active, ...position, height: heights.get(active) ?? NODE_MIN_HEIGHT }
    const previousTarget = lastFocusTarget.current
    lastFocusTarget.current = target
    // Первый показ уже вписан целиком. Центрируем только после изменений цели.
    if (!previousTarget || (previousTarget.id === target.id && previousTarget.x === target.x
      && previousTarget.y === target.y && previousTarget.height === target.height)) return
    const center = { x: position.x + NODE_WIDTH / 2, y: position.y + target.height / 2 }
    const point = flow.flowToScreenPosition(center)
    if (point.x < bounds.left + 150 || point.x > bounds.right - 150 || point.y < bounds.top + 80 || point.y > bounds.bottom - 80) {
      void flow.setCenter(center.x, center.y, { zoom: flow.getZoom(), duration: 150 })
    }
  }, [active, positions, heights, flow, drag, layoutReady])

  const run = useCallback((operation: () => void) => {
    try { operation(); setNotice(null); return true }
    catch (error) { setNotice(error instanceof DomainError ? error.message : String(error)); return false }
  }, [])
  const change = useCallback((operation: () => void) => withIdentity(() => {
    run(operation)
    focusCanvas()
  }), [withIdentity, run, focusCanvas])
  const commit = useCallback(() => {
    const current = editRef.current
    if (!current) return
    updateEdit(null)
    if (!session.identity.name) { setNotice('Представься перед редактированием. Несохранённый текст отменён.'); return }
    if (run(() => session.commands.setText(current.id, current.draft))) {
      setMessage(current.id === ROOT_ID
        ? 'Tab — дочерняя клеточка · F2 — редактировать'
        : 'Enter — соседняя клеточка · Tab — дочерняя · F2 — редактировать')
    }
  }, [run, session, updateEdit])
  useEffect(() => registerBeforeLeave(() => {
    actionEpoch.current++
    commit()
    updateDrag(null)
    setActionsOpen(false)
    setHelp(false)
  }), [registerBeforeLeave, commit, updateDrag])
  useEffect(() => {
    const prepare = () => { commit(); updateDrag(null); setActionsOpen(false) }
    session.prepare = prepare
    return () => { if (session.prepare === prepare) session.prepare = undefined }
  }, [session, commit, updateDrag])
  const saveFile = useCallback(() => {
    commit()
    if (session.file) void session.file.retry().catch(error => setNotice(String(error)))
    else { try { downloadDiagram(session.doc, documentTitle) } catch (error) { setNotice(String(error)) } }
  }, [commit, session, documentTitle])
  const downloadCopy = () => {
    try { commit(); downloadDiagram(session.doc, documentTitle); setNotice(null) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    focusCanvas()
  }
  async function openDiskFile() {
    if (pickingFile.current || switching) return
    pickingFile.current = true; setNotice(null)
    const epoch = actionEpoch.current
    try {
      // Вызываем системный picker непосредственно из нажатия, сохраняя user activation.
      const { handle, text } = await pickWritableFile()
      if (epoch !== actionEpoch.current || session.closed) return
      await openLocal(handle, text)
    } catch (error) {
      if (epoch === actionEpoch.current && !(error instanceof DOMException && error.name === 'AbortError')) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    } finally {
      pickingFile.current = false
      if (epoch === actionEpoch.current && !session.closed) focusCanvas()
    }
  }
  useEffect(() => {
    const save = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS' && !event.altKey) { event.preventDefault(); saveFile() }
    }
    window.addEventListener('keydown', save, true)
    return () => window.removeEventListener('keydown', save, true)
  }, [saveFile])
  const startEdit = useCallback((id: string, isNew = false) => withIdentity(() => {
    const lockedBy = session.participants().find(person => person.clientId !== session.doc.clientID && person.editingNode === id)
    if (lockedBy) { setNotice(`${lockedBy.name} сейчас редактирует эту клеточку.`); return }
    const node = projectTree(session.doc).nodes.get(id)
    if (!node) { setNotice('Клеточка больше не видна. Выбери другую.'); return }
    setActive(id)
    setNotice(null)
    updateEdit({ id, draft: node.text, isNew })
    setMessage('Enter — сохранить · Shift+Enter — перенос строки · Tab — сохранить и создать дочернюю · Esc — отменить')
  }), [session, updateEdit, withIdentity])
  const create = useCallback((kind: 'child' | 'sibling') => withIdentity(() => {
    const parent = editRef.current?.id ?? active
    commit()
    const created = run(() => {
      const id = kind === 'child' ? session.commands.createChild(parent) : session.commands.createSibling(parent)
      startEdit(id, true)
    })
    if (!created) focusCanvas()
  }), [active, commit, run, session, startEdit, focusCanvas, withIdentity])
  const remove = useCallback(() => withIdentity(() => {
    commit()
    run(() => session.commands.deleteSubtree(active))
    focusCanvas()
  }), [active, commit, run, session, focusCanvas, withIdentity])
  const cancel = useCallback(() => {
    const current = editRef.current
    if (!current) return
    updateEdit(null)
    if (current.isNew) {
      const latest = projectTree(session.doc)
      // Не удаляем чужую сохранённую работу или ребёнка, появившегося во время draft.
      if (latest.nodes.get(current.id)?.text === '' && (latest.children.get(current.id)?.length ?? 0) === 0) {
        run(() => {
          if (!session.history.cancelCreation(current.id)) session.commands.deleteSubtree(current.id)
        })
      }
    }
    focusCanvas()
  }, [session, updateEdit, run, focusCanvas])
  const applyHistory = useCallback((direction: 'undo' | 'redo') => {
    if (!session.ready() || editRef.current || dragRef.current) return
    change(() => {
      const before = projectTree(session.doc)
      const command = session.history[direction]()
      const after = projectTree(session.doc)
      if (command && command.kind !== 'set-text-align') {
        setActive(after.nodes.has(command.nodeId) ? command.nodeId : focusAfterRemoval(before, after, command.nodeId))
      }
      setMessage(command ? (direction === 'undo' ? 'Действие отменено.' : 'Действие повторено.') : 'Нет доступных действий.')
    })
  }, [session, change])
  const editorKey = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); cancel() }
    if (event.key === 'Enter') {
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return
      event.preventDefault()
      commit()
      focusCanvas()
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      if (event.shiftKey) { commit(); focusCanvas() } else create('child')
    }
  }, [cancel, commit, create, focusCanvas])
  const onDraft = useCallback((text: string) => {
    if (!session.canEdit) return
    if (editRef.current) updateEdit({ ...editRef.current, draft: normalizeText(text) })
  }, [updateEdit, session])

  const startDrag = (_event: unknown, node: FlowCell) => {
    if (!session.canEdit) return
    if (node.id !== active) return
    commit()
    const snapshot = beginSiblingDrag(projectTree(session.doc), node.id, positions, heights)
    if (!snapshot) return
    updateDrag({ snapshot, position: node.position, target: null, phase: 'dragging' })
    setMessage('Перетащи выше или ниже соседних клеточек. Esc — отменить.')
    focusCanvas()
  }
  const moveDrag = (_event: unknown, node: FlowCell) => {
    const current = dragRef.current
    if (current?.phase !== 'dragging') return
    updateDrag({ ...current, position: node.position, target: siblingDropTarget(current.snapshot, node.position) })
  }
  const stopDrag = (_event: unknown, node: FlowCell) => {
    const current = dragRef.current
    if (current?.phase !== 'dragging') return
    const target = siblingDropTarget(current.snapshot, node.position)
    if (!target || !isSiblingDragValid(projectTree(session.doc), current.snapshot)) {
      updateDrag(null)
      setMessage('Порядок не изменён.')
    } else {
      if (!session.identity.name) updateDrag(null)
      withIdentity(() => {
        if (!isSiblingDragValid(projectTree(session.doc), current.snapshot)) {
          updateDrag(null)
          setNotice('Структура изменилась другим участником. Повтори перетаскивание.')
          return
        }
        const moved = run(() => session.commands.move(node.id, current.snapshot.parentId, target.index))
        updateDrag(moved ? { ...current, position: node.position, target: null, phase: 'settling' } : null)
        if (moved) setMessage('Порядок клеточек изменён.')
        focusCanvas()
      })
    }
    focusCanvas()
  }

  const nodes: FlowCell[] = [...tree.nodes.values()].map(node => ({
    id: node.id, type: 'cell',
    position: drag?.snapshot.id === node.id ? drag.position : positions.get(node.id) ?? { x: 0, y: 0 },
    style: { opacity: positions.has(node.id) ? 1 : 0, pointerEvents: positions.has(node.id) ? 'auto' : 'none' },
    draggable: session.canEdit && node.id === active && positions.has(node.id) && node.id !== ROOT_ID && edit?.id !== node.id && drag?.phase !== 'settling'
      && (tree.children.get(node.parentId ?? '')?.length ?? 0) > 1,
    zIndex: drag?.snapshot.id === node.id ? 1001 : 0,
    measured: { width: NODE_WIDTH, height: heights.get(node.id) ?? NODE_MIN_HEIGHT },
    selected: node.id === active,
    data: {
      node, index: (tree.children.get(node.parentId ?? '') ?? []).indexOf(node.id),
      active: node.id === active, edit: edit?.id === node.id ? edit : null, textAlign,
      positioned: positions.has(node.id),
      dropSide: drag?.target?.anchorId === node.id ? drag.target.side : null,
      dragging: drag?.snapshot.id === node.id,
      others: others.filter(person => person.activeNode === node.id || person.editingNode === node.id),
      onDraft, onEditorKey: editorKey, onCommit: commit, onMeasure: measure,
    },
  }))
  const edges: Edge[] = [...tree.nodes.values()].flatMap(node => node.parentId ? [{
    id: node.id, source: node.parentId, target: node.id, type: 'smoothstep',
    hidden: !positions.has(node.id) || !positions.has(node.parentId),
    style: { stroke: '#bdb8aa', strokeWidth: 1.5 },
  }] : [])
  const dropAnchor = drag?.target ? positions.get(drag.target.anchorId) : undefined
  const dropY = dropAnchor && drag?.target
    ? dropAnchor.y + (drag.target.side === 'before' ? -14 : (heights.get(drag.target.anchorId) ?? NODE_MIN_HEIGHT) + 12)
    : 0

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!ready || editRef.current || event.nativeEvent.isComposing) return
    if ((event.target as HTMLElement).closest('button, a, input, textarea, select')) return
    if (event.key === 'Enter' && event.repeat) { event.preventDefault(); return }
    if (dragRef.current) {
      event.preventDefault()
      if (event.key === 'Escape' && dragRef.current.phase === 'dragging') {
        updateDrag(null)
        setMessage('Перетаскивание отменено.')
      }
      return
    }
    const ctrl = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (ctrl && !event.altKey && (event.code === 'KeyZ' || key === 'z' || event.code === 'KeyY' || key === 'y')) {
      event.preventDefault()
      event.stopPropagation()
      applyHistory(event.shiftKey || event.code === 'KeyY' || key === 'y' ? 'redo' : 'undo')
      return
    }
    const action = () => {
      if (event.key === 'Escape') { toolbar.current?.focus(); return }
      if (event.key === 'Enter') { create('sibling'); return }
      if (event.key === 'Tab' && !event.shiftKey) { create('child'); return }
      if (event.key === 'F2') { startEdit(active); return }
      if (event.key === 'Delete') { remove(); return }
      if (event.key === ' ') { change(() => session.commands.toggleStatus(active)); return }
      if ((event.key === 'Tab' && event.shiftKey) || (ctrl && event.key === 'ArrowLeft')) {
        change(() => session.commands.outdent(active)); return
      }
      if (ctrl && event.key === 'ArrowRight') { change(() => session.commands.indent(active)); return }
      if (ctrl && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        change(() => session.commands.reorder(active, event.key === 'ArrowUp' ? -1 : 1)); return
      }
      if (event.key.startsWith('Arrow')) setActive(navigate(tree, active, event.key))
    }
    if (['Escape', 'Enter', 'Tab', 'F2', 'Delete', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      action()
    }
  }

  return <>
    {createPortal(<>
      <DiagramPicker id={session.id} title={documentTitle} tracker={session.tracker} connected={session.source === 'system' ? connected : navigator.onLine}
        currentSection={session.source !== 'system' ? 'files' : session.tracker ? 'tracker' : 'diagrams'}
        modeLabel={session.source === 'file' ? 'Файл на диске' : session.source === 'guest' ? 'По ссылке' : session.tracker ? 'Задача' : 'Внутренняя схема'}
        currentName={session.file?.handle.name || session.fileName || trackerLabel(documentTitle, session.tracker?.trackerKey)}
        triggerContent={session.source !== 'system' ? <FileIndicator session={session} /> : undefined}
        temporary={session.source !== 'system' || session.deleted} navigate={navigateToDiagram} requestIdentity={requestIdentity}
        prepare={commit} returnFocus={focusCanvas} openFile={mode => { if (mode === 'disk') void openDiskFile(); else fileActions.current?.open(mode) }} actions={close => <>
          {session.source === 'system' && <>
            <button disabled={!ready || switching} onClick={() => { close(); downloadCopy() }}>Сохранить в файл</button>
            <button disabled={session.id === 'main' || !connected || !session.canEdit || switching} title={session.id === 'main' ? 'Основная схема защищена от удаления' : 'Удалить внутреннюю копию после записи и перейти к файлу'}
              onClick={() => { close(); setStorageMode('transfer') }}>Перенести в файл</button>
            <button disabled={!ready || !connected || !session.canEdit || switching} onClick={() => { close(); fileActions.current?.open('replace') }}>Заменить из файла</button>
            <button className="delete-button" disabled={session.id === 'main' || !connected || !session.canEdit || switching}
              onClick={() => { close(); setStorageMode('delete') }}>Удалить схему</button>
          </>}
          {session.file && <>
            <button disabled={sharing || !navigator.onLine} onClick={() => {
              close(); commit(); focusCanvas(); setSharing(true)
              void shareFileSession(session).then(setShareLink).catch(error => { setNotice(String(error)); focusCanvas() }).finally(() => setSharing(false))
            }}>{sharing ? 'Подключаем' : 'Поделиться сессией'}</button>
            <button disabled={!ready || switching || !navigator.onLine} onClick={() => { close(); setStorageMode('internal') }}>Сохранить как внутреннюю</button>
          </>}
          {session.source !== 'system' && <button disabled={!ready || switching} onClick={() => { close(); downloadCopy() }}>Скачать копию</button>}
        </>} />
      {!session.waitingForOwner && (session.source !== 'file' || session.provider) && <div className="connection" data-testid="connection" data-connected={String(connected)}
        title={connected ? 'В сети' : 'Offline'}
        aria-label={connected ? 'В сети' : 'Offline'}>
        <i className={connected ? 'online' : 'offline'} /><span>{connected ? 'В сети' : 'Offline'}</span>
      </div>}
      <div className="avatars" aria-label="Участники">
        <button className={identity.name ? 'identity-trigger' : 'introduce-button'} disabled={switching}
          aria-label={identity.name ? 'Изменить имя' : 'Представиться'} title={identity.name ? 'Изменить имя' : 'Представиться'} aria-haspopup="dialog" onClick={editIdentity}>
          {identity.name ? <span data-user-id={identity.id} title={`${identity.name} (ты)`}
            style={{ background: identity.color }}>{initials(identity.name)}</span> : <>
            <small className="introduce-label">Представиться</small>
            <svg className="introduce-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" />
            </svg>
          </>}
        </button>
        {avatars.slice(0, identity.name ? 2 : 3).map(person => <span className="remote-avatar" key={person.id} data-user-id={person.id}
          title={person.name} style={{ background: person.color }}>{initials(person.name)}</span>)}
      </div>
      {presence.named.length > 3 && <span className="participant-count" title={avatars.slice(identity.name ? 2 : 3).map(person => person.name).join(', ')}>+{presence.named.length - 3}</span>}
      {presence.guests > 0 && <span className="guest-count" title="Непредставившиеся посетители этой схемы">Гостей: {presence.guests}</span>}
      <button className="icon-button" aria-label="Отменить действие" title="Отменить действие (Ctrl/⌘+Z)"
        disabled={switching || !ready || !session.canEdit || !!edit || !!drag || !session.history.canUndo} onClick={() => applyHistory('undo')}>↶</button>
      <button className="icon-button" aria-label="Повторить действие" title="Повторить действие (Ctrl/⌘+Shift+Z, Ctrl+Y)"
        disabled={switching || !ready || !session.canEdit || !!edit || !!drag || !session.history.canRedo} onClick={() => applyHistory('redo')}>↷</button>
      <button className="icon-button" aria-label="Вся схема" title="Показать всю схему" disabled={!layoutReady}
        onClick={() => { void flow.fitView({ padding: 0.2, maxZoom: 1 }); focusCanvas() }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" /></svg>
      </button>
      <button className="icon-button" aria-label="Клавиши" title="Клавиатурная справка" aria-expanded={help}
        onClick={() => { setHelp(value => !value); setActionsOpen(false) }}>?</button>
      <div className="actions" ref={actionsContainer}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setActionsOpen(false) }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); setActionsOpen(false); toolbar.current?.focus() }
        }}>
        <button ref={toolbar} disabled={switching} className="icon-button" aria-label="Действия с клеточкой" title="Действия с клеточкой"
          aria-expanded={actionsOpen} aria-controls="cell-actions"
          onClick={() => { setActionsOpen(value => !value); setHelp(false) }}>⋯</button>
        {actionsOpen && <div id="cell-actions" className="actions-panel" role="group" aria-label="Действия с выбранной клеточкой">
          <button disabled={!ready || !session.canEdit} onClick={() => { setActionsOpen(false); create('child') }}>Дочерняя <kbd>Tab</kbd></button>
          <button disabled={!ready || !session.canEdit || active === ROOT_ID} onClick={() => { setActionsOpen(false); create('sibling') }}>Рядом <kbd>Enter</kbd></button>
          <button disabled={!ready || !session.canEdit} onClick={() => { setActionsOpen(false); startEdit(active) }}>Редактировать <kbd>F2</kbd></button>
          <button disabled={!ready || !session.canEdit} onClick={() => { setActionsOpen(false); commit(); change(() => session.commands.toggleStatus(active)) }}>Статус <kbd>Space</kbd></button>
          <button className="delete-button" aria-label="Удалить" disabled={!ready || !session.canEdit || active === ROOT_ID} onClick={() => { setActionsOpen(false); remove() }}>Удалить <kbd>Delete</kbd></button>
          <fieldset className="diagram-settings" disabled={!ready || switching || !!drag}>
            <legend>Схема</legend>
            {/* Фокус остаётся внутри меню до штатного click по связанному checkbox. */}
            <label tabIndex={-1}><input type="checkbox" disabled={!session.canEdit} checked={textAlign === 'center'} onChange={event => {
              const next = event.target.checked ? 'center' : 'left'
              setActionsOpen(false)
              commit()
              change(() => session.commands.setTextAlign(next))
            }} />Текст карточек по центру</label>
          </fieldset>
        </div>}
      </div>
    </>, header)}
    <FileActions ref={fileActions} returnFocus={focusCanvas} reportError={setNotice} session={session} title={trackerLabel(documentTitle, session.tracker?.trackerKey)}
      navigate={navigateToDiagram} requestIdentity={requestIdentity} />
    <StorageActions mode={storageMode} close={() => setStorageMode(null)} returnFocus={focusCanvas} session={session} title={documentTitle}
      navigate={navigateToDiagram} openLocal={openLocal} requestIdentity={requestIdentity} />
    <dialog ref={shareDialog} className="diagrams-dialog file-dialog" aria-label="Совместная файловая сессия" onClose={focusCanvas} onCancel={() => setShareLink('')}>
      <h2>Совместная файловая сессия</h2>
      <p>Передай ссылку ниже участникам. Адрес этой вкладки остаётся локальным. Держи её открытой: только она сохраняет изменения в твой файл.</p>
      <input aria-label="Ссылка файловой сессии" readOnly value={shareLink} onFocus={event => event.target.select()} />
      <button onClick={() => setShareLink('')}>Готово</button>
      <button onClick={() => { session.roomClose?.(); setShareLink('') }}>Завершить сессию</button>
    </dialog>
    <main ref={canvas} className="canvas" tabIndex={0} onKeyDown={keyDown} inert={switching}
      aria-label="Дерево декомпозиции" aria-describedby="keyboard-status" data-diagram-id={session.id} data-ready={String(ready && layoutReady && !switching)}>
      {ready ? <ReactFlow<FlowCell> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        style={{ opacity: layoutReady ? 1 : 0, pointerEvents: layoutReady ? 'auto' : 'none' }}
        nodesConnectable={false} nodesFocusable={false} edgesFocusable={false}
        onNodeDragStart={startDrag} onNodeDrag={moveDrag} onNodeDragStop={stopDrag}
        nodeDragThreshold={5} autoPanOnNodeDrag={false} zoomOnDoubleClick={false}
        disableKeyboardA11y deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        minZoom={0.2} maxZoom={1.6} proOptions={{ hideAttribution: false }}
        onNodeClick={(_event, node) => { if (node.id !== editRef.current?.id) { commit(); setActive(node.id); focusCanvas() } }}
        onNodeDoubleClick={(_event, node) => startEdit(node.id)}
        onPaneClick={() => { commit(); focusCanvas() }}>
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#d9d5c9" />
        {dropAnchor && <ViewportPortal><div className="drop-indicator" data-testid="drop-indicator"
          style={{ transform: `translate(${dropAnchor.x - 8}px, ${dropY}px)`, width: NODE_WIDTH + 16 }} /></ViewportPortal>}
      </ReactFlow> : <div className="loading" role="status">{session.waitingForOwner ? 'Ожидаем владельца файла. Схема откроется автоматически, когда он откроет файл.' : connected ? 'Открываем документ…' : 'Для первого открытия документа нужно соединение с сервером.'}</div>}
      {notice && <div className="notice" role="alert"><span>{notice}</span>
        <button aria-label="Закрыть сообщение" onClick={() => { setNotice(null); focusCanvas() }}>×</button>
      </div>}
      {(session.message || session.file?.error) && <div className="notice file-notice" role="alert">
        <span>{session.file?.error || session.message}</span>
        <button onClick={() => { try { downloadDiagram(session.doc, documentTitle) } catch (error) { setNotice(String(error)) } }}>Скачать копию</button>
        {session.file?.error && <button onClick={saveFile}>Повторить сохранение</button>}
        {(session.outdated || session.source === 'guest' && !session.canEdit) && <button onClick={() => { void reload() }}>Открыть актуальную схему</button>}
      </div>}
      {session.fileNotice && !session.message && !session.file?.error && <div className="notice file-notice file-info" role="status">
        <span>{session.fileNotice}</span>
        <button aria-label="Закрыть сообщение" onClick={() => { session.fileNotice = ''; session.emit(); focusCanvas() }}>×</button>
      </div>}
      {help && <aside className="help-panel" aria-label="Клавиатурная справка">
        <h2>Клавиатура и мышь</h2><p>Щёлкни клеточку или перейди к схеме клавишей Tab.</p>
        {[
          ['Tab / Enter', 'В навигации: child / sibling'], ['Стрелки', 'Parent, child и siblings'],
          ['Ctrl + ↑ / ↓', 'Выше / ниже среди siblings'], ['Ctrl + → / ←', 'Indent / outdent'],
          ['Shift + Tab', 'Outdent'], ['F2 / двойной клик', 'Редактировать текст'],
          ['Space', 'Открыто / готово'], ['Delete', 'Удалить поддерево'],
          ['Enter / Ctrl + Enter', 'В редакторе: сохранить'], ['Esc в редакторе', 'Отменить draft'],
          ['Shift + Enter', 'В редакторе: перенос строки'],
          ['Esc на схеме', 'Вернуться к панели действий'],
          ['Ctrl + Z', 'Отменить действие'], ['Ctrl + Shift + Z / Y', 'Повторить действие'],
          ['Ctrl + O', 'Выбрать схему для редактирования'],
          ['Ctrl + S', 'Сохранить схему в файл'],
        ].map(([key, label]) => <div className="help-row" key={key}><span>{label}</span><kbd>{key}</kbd></div>)}
        <p>Мышью: клик активирует клеточку. Тяни активную клеточку, чтобы изменить порядок среди детей одного родителя; неактивную — чтобы переместить холст без смены выделения. Esc отменяет перестановку.</p>
        <p>На macOS вместо Ctrl можно использовать ⌘. Текст клеточки сохраняется целиком.</p>
        <p>В редакторе undo/redo меняет только draft. На схеме — твои действия в этой вкладке. После перезагрузки история очищается.</p>
        <button onClick={() => { setHelp(false); focusCanvas() }}>Вернуться к схеме</button>
      </aside>}
    </main>
    <div id="keyboard-status" className="sr-only" role="status">{message}</div>
  </>
}
