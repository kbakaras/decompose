import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, ViewportPortal, getNodesBounds, getViewportForBounds, useReactFlow, type Edge } from '@xyflow/react'
import { DomainError, ROOT_ID, projectTree, normalizeText, readTextAlign } from '../domain'
import { diagramTitle } from '../shared/diagrams'
import { normalizeTrackerKey, trackerLabel, trackerUrl } from '../shared/tracker'
import type { Session } from './session'
import { Cell, type EditState, type FlowCell } from './Cell'
import { DiagramPicker } from './DiagramPicker'
import { focusAfterRemoval, navigate } from './interaction'
import { layoutTree, NODE_WIDTH, NODE_MIN_HEIGHT } from './layout'
import { beginTreeDrag, isTreeDragValid, treeDropTarget, type DragPreview, type Point } from './sibling-drag'
import { browserIdentity, initials, subscribeIdentity } from './identity'
import { summarizeParticipants } from './presence'
import { FileActions, type FileActionsHandle } from './FileActions'
import { downloadDiagram, pickWritableFile } from './diagram-file'
import { shareFileSession, type OpenLocalFile } from './file-session'
import { StorageActions, type StorageAction } from './StorageActions'
import { FileIndicator } from './FileIndicator'
import { copySubtreeToSystemClipboard, readSubtreeClipboard, subtreeForClipboard, writeSubtreeClipboard } from './tree-clipboard'
import { hasTextConflict } from './text-draft'

const nodeTypes = { cell: Cell }

interface WorkspaceProps {
  session: Session
  header: HTMLElement
  switching: boolean
  navigate: (url: string) => Promise<void>
  registerBeforeLeave: (callback: () => boolean) => () => void
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
  const observedTextConflict = useRef<{ id: string; text: string } | null>(null)
  const [textConflict, setTextConflict] = useState<string | null>(null)
  const textConflictDialog = useRef<HTMLDialogElement>(null)
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
  const [parameters, setParameters] = useState<{ id: string; draft: string; error: string } | null>(null)
  const parametersDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (parameters) parametersDialog.current?.showModal(); else parametersDialog.current?.close() }, [parameters])
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
  const presence = summarizeParticipants(participants, identity, session.participantRoster())
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
  useEffect(() => {
    const current = editRef.current
    const latest = current && tree.nodes.get(current.id)
    observedTextConflict.current = current && latest && hasTextConflict(current.baseText, current.draft, latest.text)
      ? { id: current.id, text: latest.text }
      : null
  }, [edit, tree])
  useEffect(() => {
    if (textConflict) textConflictDialog.current?.showModal()
    else textConflictDialog.current?.close()
  }, [textConflict])
  const focusCanvas = useCallback(() => {
    // Закрытие одного диалога не должно отбирать фокус у следующего.
    if (!editRef.current && !document.querySelector('dialog[open]')) {
      window.getSelection()?.removeAllRanges()
      canvas.current?.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    let frame = 0
    const restoreKeyboardFocus = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!document.hasFocus() || document.visibilityState === 'hidden' || switching || !ready
          || document.querySelector('dialog[open]')) return
        const focused = document.activeElement
        if (focused && focused !== document.body && focused !== document.documentElement) return
        const editor = editRef.current && canvas.current?.querySelector<HTMLTextAreaElement>('.cell-editor')
        if (editor) editor.focus({ preventScroll: true })
        else focusCanvas()
      })
    }
    window.addEventListener('focus', restoreKeyboardFocus)
    document.addEventListener('visibilitychange', restoreKeyboardFocus)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('focus', restoreKeyboardFocus)
      document.removeEventListener('visibilitychange', restoreKeyboardFocus)
    }
  }, [focusCanvas, ready, switching])
  useEffect(() => {
    session.setPresence('activeNode', active)
    if (ready && !switching && !editRef.current) focusCanvas()
  }, [active, ready, switching, session, focusCanvas])
  useEffect(() => {
    if (!tree.nodes.has(active)) {
      setActive(focusAfterRemoval(previous.current, tree, active))
      updateEdit(null)
      setTextConflict(null)
      setMessage('Клеточка больше не видна. Выбран ближайший узел.')
    }
    previous.current = tree
  }, [tree, active, updateEdit])

  const measure = useCallback((id: string, height: number) => {
    setHeights(old => old.get(id) === height ? old : new Map(old).set(id, height))
  }, [])
  useEffect(() => {
    if (drag?.phase === 'dragging' && !isTreeDragValid(tree, drag.snapshot, drag.target)) {
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
    if (!current) return true
    if (!session.identity.name) {
      updateEdit(null)
      setNotice('Представься перед редактированием. Несохранённый текст отменён.')
      return false
    }
    const latest = projectTree(session.doc).nodes.get(current.id)
    if (!latest) {
      updateEdit(null)
      setTextConflict(null)
      setNotice('Клеточка больше не видна. Черновик не сохранён.')
      return false
    }
    const observed = observedTextConflict.current
    if (hasTextConflict(current.baseText, current.draft, latest.text)
      || observed?.id === current.id && observed.text !== current.draft) {
      setTextConflict(current.id)
      return false
    }
    updateEdit(null)
    setTextConflict(null)
    if (current.draft === latest.text || current.draft === current.baseText) return true
    if (run(() => session.commands.setText(current.id, current.draft))) {
      setMessage(current.id === ROOT_ID
        ? 'Tab — дочерняя клеточка · F2 — редактировать'
        : 'Enter — соседняя клеточка · Tab — дочерняя · F2 — редактировать')
      return true
    }
    return false
  }, [run, session, updateEdit])
  useEffect(() => registerBeforeLeave(() => {
    actionEpoch.current++
    if (!commit()) return false
    updateDrag(null)
    setActionsOpen(false)
    setHelp(false)
    setParameters(null)
    return true
  }), [registerBeforeLeave, commit, updateDrag])
  useEffect(() => {
    const prepare = () => {
      if (!commit()) return false
      updateDrag(null)
      setActionsOpen(false)
      return true
    }
    session.prepare = prepare
    return () => { if (session.prepare === prepare) session.prepare = undefined }
  }, [session, commit, updateDrag])
  const saveFile = useCallback(() => {
    if (!commit()) return
    if (session.file) void session.file.retry().catch(error => setNotice(String(error)))
    else { try { downloadDiagram(session.doc, documentTitle) } catch (error) { setNotice(String(error)) } }
  }, [commit, session, documentTitle])
  const downloadCopy = () => {
    try {
      if (!commit()) return
      downloadDiagram(session.doc, documentTitle); setNotice(null)
    }
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
    observedTextConflict.current = null
    updateEdit({ id, draft: node.text, baseText: node.text, isNew })
    setMessage('Enter — сохранить · Shift+Enter — перенос строки · Tab — сохранить и создать дочернюю · Esc — отменить')
  }), [session, updateEdit, withIdentity])
  const openParameters = useCallback((id: string) => withIdentity(() => {
    if (!commit()) return
    const node = projectTree(session.doc).nodes.get(id)
    if (!node) { setNotice('Клеточка больше не видна. Выбери другую.'); return }
    setActive(id)
    setActionsOpen(false)
    setParameters({ id, draft: node.targetTrackerKey ?? '', error: '' })
  }), [commit, session, withIdentity])
  const closeParameters = useCallback(() => {
    setParameters(null)
    focusCanvas()
  }, [focusCanvas])
  const saveParameters = useCallback(() => {
    if (!parameters) return
    const key = parameters.draft === '' ? null : normalizeTrackerKey(parameters.draft)
    if (parameters.draft !== '' && key === null) {
      setParameters({ ...parameters, error: 'Введи ключ вида MC-99636 без пробелов.' })
      return
    }
    if (run(() => session.commands.setTrackerLink(parameters.id, key))) {
      setParameters(null)
      setMessage(key ? `Карточка связана с задачей ${key}.` : 'Ссылка карточки удалена.')
      focusCanvas()
    }
  }, [parameters, run, session, focusCanvas])
  const followTrackerLink = useCallback((key: string) => {
    if (!commit()) return
    setParameters(null)
    void navigateToDiagram(trackerUrl(key))
  }, [commit, navigateToDiagram])
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      const focused = document.activeElement
      const focusLost = focused === document.body || focused === document.documentElement
      if (event.key !== 'F4' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || !session.tracker || !ready || switching || editRef.current || document.querySelector('dialog[open]')
        || (!focusLost && !canvas.current?.contains(event.target as Node))) return
      event.preventDefault()
      event.stopPropagation()
      openParameters(active)
    }
    window.addEventListener('keydown', shortcut, true)
    return () => window.removeEventListener('keydown', shortcut, true)
  }, [active, openParameters, ready, session.tracker, switching])
  const create = useCallback((kind: 'child' | 'sibling') => withIdentity(() => {
    const parent = editRef.current?.id ?? active
    if (!commit()) return
    const created = run(() => {
      const id = kind === 'child' ? session.commands.createChild(parent) : session.commands.createSibling(parent)
      startEdit(id, true)
    })
    if (!created) focusCanvas()
  }), [active, commit, run, session, startEdit, focusCanvas, withIdentity])
  const remove = useCallback(() => withIdentity(() => {
    if (!commit()) return
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
  const continueTextEdit = useCallback(() => {
    setTextConflict(null)
    requestAnimationFrame(() => canvas.current?.querySelector<HTMLTextAreaElement>('.cell-editor')?.focus({ preventScroll: true }))
  }, [])
  const keepCurrentText = useCallback(() => {
    setTextConflict(null)
    updateEdit(null)
    setMessage('Сохранена актуальная версия текста. Твой черновик отброшен.')
    requestAnimationFrame(focusCanvas)
  }, [focusCanvas, updateEdit])
  const overwriteCurrentText = useCallback(() => {
    const current = editRef.current
    setTextConflict(null)
    if (!current) { focusCanvas(); return }
    const latest = projectTree(session.doc).nodes.get(current.id)
    if (!latest) {
      updateEdit(null)
      setNotice('Клеточка больше не видна. Черновик не сохранён.')
      requestAnimationFrame(focusCanvas)
      return
    }
    updateEdit(null)
    if (current.draft !== latest.text && run(() => session.commands.setText(current.id, current.draft))) {
      setMessage('Текст карточки заменён твоим черновиком.')
    }
    requestAnimationFrame(focusCanvas)
  }, [focusCanvas, run, session, updateEdit])
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
      if (commit()) focusCanvas()
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      if (event.shiftKey) { if (commit()) focusCanvas() } else create('child')
    }
  }, [cancel, commit, create, focusCanvas])
  const onDraft = useCallback((text: string) => {
    if (!session.canEdit) return
    if (editRef.current) updateEdit({ ...editRef.current, draft: normalizeText(text) })
  }, [updateEdit, session])

  const pointerPosition = (event: unknown): Point | null => {
    const value = event as { clientX?: number; clientY?: number; touches?: ArrayLike<{ clientX: number; clientY: number }> }
    const pointer = value.touches?.[0] ?? value
    return typeof pointer.clientX === 'number' && typeof pointer.clientY === 'number'
      ? flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY })
      : null
  }
  const startDrag = (_event: unknown, node: FlowCell) => {
    if (!session.canEdit) return
    if (node.id !== active) return
    if (!commit()) return
    const snapshot = beginTreeDrag(projectTree(session.doc), node.id, positions, heights)
    if (!snapshot) return
    updateDrag({ snapshot, position: node.position, target: null, phase: 'dragging' })
    setMessage('Перетащи карточку на нового родителя или к нужному месту в списке. Esc — отменить.')
    focusCanvas()
  }
  const moveDrag = (event: unknown, node: FlowCell) => {
    const current = dragRef.current
    if (current?.phase !== 'dragging') return
    const pointer = pointerPosition(event)
    updateDrag({ ...current, position: node.position, target: pointer ? treeDropTarget(current.snapshot, pointer) : null })
  }
  const stopDrag = (event: unknown, node: FlowCell) => {
    const current = dragRef.current
    if (current?.phase !== 'dragging') return
    const pointer = pointerPosition(event)
    const target = pointer ? treeDropTarget(current.snapshot, pointer) : current.target
    if (!target || !isTreeDragValid(projectTree(session.doc), current.snapshot, target)) {
      updateDrag(null)
      setMessage('Структура не изменена.')
    } else {
      if (!session.identity.name) updateDrag(null)
      withIdentity(() => {
        if (!isTreeDragValid(projectTree(session.doc), current.snapshot, target)) {
          updateDrag(null)
          setNotice('Структура изменилась другим участником. Повтори перетаскивание.')
          return
        }
        const moved = run(() => session.commands.move(node.id, target.parentId, target.index))
        updateDrag(moved ? { ...current, position: node.position, target: null, phase: 'settling' } : null)
        if (moved) setMessage(target.parentId === current.snapshot.parentId ? 'Порядок карточек изменён.' : 'Карточка перенесена к другому родителю.')
        focusCanvas()
      })
    }
    focusCanvas()
  }

  const nodes: FlowCell[] = [...tree.nodes.values()].map(node => ({
    id: node.id, type: 'cell',
    position: drag?.snapshot.id === node.id ? drag.position : positions.get(node.id) ?? { x: 0, y: 0 },
    style: { opacity: positions.has(node.id) ? 1 : 0, pointerEvents: positions.has(node.id) ? 'auto' : 'none' },
    draggable: session.canEdit && node.id === active && positions.has(node.id) && node.id !== ROOT_ID && edit?.id !== node.id && drag?.phase !== 'settling',
    zIndex: drag?.snapshot.id === node.id ? 1001 : 0,
    measured: { width: NODE_WIDTH, height: heights.get(node.id) ?? NODE_MIN_HEIGHT },
    selected: node.id === active,
    data: {
      node, index: (tree.children.get(node.parentId ?? '') ?? []).indexOf(node.id),
      active: node.id === active, edit: edit?.id === node.id ? edit : null, textAlign,
      positioned: positions.has(node.id),
      dropTarget: drag?.target?.anchorId === node.id ? (drag.target.kind === 'child' ? 'child' : drag.target.side) : null,
      dragging: drag?.snapshot.id === node.id,
      others: others.filter(person => person.activeNode === node.id || person.editingNode === node.id),
      onDraft, onEditorKey: editorKey, onCommit: commit, onMeasure: measure, onFollowLink: followTrackerLink,
    },
  }))
  const draggedId = drag?.phase === 'dragging' ? drag.snapshot.id : null
  const previewParentId = drag?.phase === 'dragging' ? drag.target?.parentId : null
  const edges: Edge[] = [...tree.nodes.values()].flatMap(node => {
    const preview = node.id === draggedId
    const source = preview ? previewParentId : node.parentId
    return source ? [{
      id: node.id, source, target: node.id, type: 'smoothstep',
      hidden: !positions.has(node.id) || !positions.has(source),
      className: preview ? 'edge-preview' : undefined,
      style: { stroke: preview ? '#687c5f' : '#bdb8aa', strokeWidth: preview ? 2 : 1.5 },
    }] : []
  })
  const siblingDrop = drag?.target?.kind === 'sibling' ? drag.target : null
  const dropAnchor = siblingDrop ? positions.get(siblingDrop.anchorId) : undefined
  const dropY = dropAnchor && siblingDrop
    ? dropAnchor.y + (siblingDrop.side === 'before' ? -14 : (heights.get(siblingDrop.anchorId) ?? NODE_MIN_HEIGHT) + 12)
    : 0

  const nativeClipboardTarget = (target: EventTarget | null) => (
    target instanceof HTMLElement && !!target.closest('button, a, input, textarea, select, [contenteditable="true"]')
  )
  const hasTextSelection = () => window.getSelection()?.isCollapsed === false
  const copyActive = (write: (snapshot: ReturnType<typeof subtreeForClipboard>) => void) => {
    try {
      write(subtreeForClipboard(projectTree(session.doc), active))
      setMessage(active === ROOT_ID ? 'Схема скопирована.' : 'Поддерево скопировано.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }
  const cutActive = (write: (snapshot: ReturnType<typeof subtreeForClipboard>) => void) => {
    if (!session.canEdit) { setMessage('Схема открыта только для просмотра.'); return }
    if (active === ROOT_ID) { setMessage('Корневую карточку нельзя вырезать.'); return }
    if (!session.identity.name) {
      const epoch = actionEpoch.current
      void requestIdentity().then(accepted => {
        if (accepted && epoch === actionEpoch.current && session.identity.name) setMessage('Теперь повтори Ctrl+X.')
      })
      return
    }
    const before = projectTree(session.doc)
    try { write(subtreeForClipboard(before, active)) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return }
    if (run(() => session.commands.deleteSubtree(active))) {
      const after = projectTree(session.doc)
      setActive(focusAfterRemoval(before, after, active))
      setMessage('Поддерево вырезано.')
      focusCanvas()
    }
  }
  const copyToClipboard = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!ready || nativeClipboardTarget(event.target) || editRef.current || dragRef.current || hasTextSelection()) return
    event.preventDefault()
    event.stopPropagation()
    copyActive(snapshot => writeSubtreeClipboard(event.clipboardData, snapshot))
  }
  const cutToClipboard = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!ready || nativeClipboardTarget(event.target) || editRef.current || dragRef.current || hasTextSelection()) return
    event.preventDefault()
    event.stopPropagation()
    cutActive(snapshot => writeSubtreeClipboard(event.clipboardData, snapshot))
  }
  const pasteFromClipboard = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!ready || nativeClipboardTarget(event.target) || editRef.current || dragRef.current) return
    event.preventDefault()
    event.stopPropagation()
    if (!session.canEdit) { setMessage('Схема открыта только для просмотра.'); return }
    let snapshot
    try { snapshot = readSubtreeClipboard(event.clipboardData) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); return }
    withIdentity(() => {
      const inserted = run(() => {
        const id = session.commands.insertSubtree(active, snapshot)
        setActive(id)
      })
      if (inserted) setMessage('Поддерево вставлено.')
      focusCanvas()
    })
  }

  const keyDown = (event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) => {
    const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event
    if (!ready || switching || editRef.current || nativeEvent.isComposing) return
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
    if (ctrl && !event.altKey && (event.code === 'KeyC' || key === 'c' || event.code === 'KeyX' || key === 'x')) {
      if (hasTextSelection()) return
      event.preventDefault()
      event.stopPropagation()
      if (event.code === 'KeyX' || key === 'x') cutActive(copySubtreeToSystemClipboard)
      else copyActive(copySubtreeToSystemClipboard)
      focusCanvas()
      return
    }
    if (ctrl && !event.altKey && (event.code === 'KeyZ' || key === 'z' || event.code === 'KeyY' || key === 'y')) {
      event.preventDefault()
      event.stopPropagation()
      applyHistory(event.shiftKey || event.code === 'KeyY' || key === 'y' ? 'redo' : 'undo')
      return
    }
    const action = () => {
      if (event.key === 'Escape') { toolbar.current?.focus(); return }
      if (event.key === 'Enter' && ctrl && session.tracker) {
        const target = tree.nodes.get(active)?.targetTrackerKey
        if (target) followTrackerLink(target)
        else setMessage('У активной карточки нет ссылки на задачу.')
        return
      }
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
  useEffect(() => {
    const recoverLostKeyboardFocus = (event: globalThis.KeyboardEvent) => {
      const focused = document.activeElement
      if (focused !== document.body && focused !== document.documentElement) return
      if (document.querySelector('dialog[open]')) return
      focusCanvas()
      keyDown(event)
    }
    window.addEventListener('keydown', recoverLostKeyboardFocus)
    return () => window.removeEventListener('keydown', recoverLostKeyboardFocus)
  })

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
            <button disabled={!connected || !session.canEdit || switching} title="Удалить внутреннюю копию после записи и перейти к файлу"
              onClick={() => { close(); setStorageMode('transfer') }}>Перенести в файл</button>
            <button disabled={!ready || !connected || !session.canEdit || switching} onClick={() => { close(); fileActions.current?.open('replace') }}>Заменить из файла</button>
            <button className="delete-button" disabled={!connected || !session.canEdit || switching}
              onClick={() => { close(); setStorageMode('delete') }}>Удалить схему</button>
          </>}
          {session.file && <>
            <button disabled={sharing || !navigator.onLine} onClick={() => {
              if (!commit()) return
              close(); focusCanvas(); setSharing(true)
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
          {session.tracker && <button disabled={!ready || !session.canEdit} onClick={() => openParameters(active)}>Параметры <kbd>F4</kbd></button>}
          <button disabled={!ready || !session.canEdit} onClick={() => {
            setActionsOpen(false)
            if (commit()) change(() => session.commands.toggleStatus(active))
          }}>Статус <kbd>Space</kbd></button>
          <button className="delete-button" aria-label="Удалить" disabled={!ready || !session.canEdit || active === ROOT_ID} onClick={() => { setActionsOpen(false); remove() }}>Удалить <kbd>Delete</kbd></button>
          <fieldset className="diagram-settings" disabled={!ready || switching || !!drag}>
            <legend>Схема</legend>
            {/* Фокус остаётся внутри меню до штатного click по связанному checkbox. */}
            <label tabIndex={-1}><input type="checkbox" disabled={!session.canEdit} checked={textAlign === 'center'} onChange={event => {
              const next = event.target.checked ? 'center' : 'left'
              setActionsOpen(false)
              if (commit()) change(() => session.commands.setTextAlign(next))
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
    <dialog ref={parametersDialog} className="diagrams-dialog card-parameters-dialog" aria-labelledby="card-parameters-heading"
      onCancel={event => { event.preventDefault(); closeParameters() }}>
      <form onSubmit={event => { event.preventDefault(); saveParameters() }}>
        <h2 id="card-parameters-heading">Параметры карточки</h2>
        <label htmlFor="card-tracker-link">Ссылка на задачу</label>
        <input id="card-tracker-link" aria-describedby={parameters?.error ? 'card-parameters-error' : undefined}
          autoFocus autoComplete="off" spellCheck={false} value={parameters?.draft ?? ''}
          onChange={event => setParameters(current => current && { ...current, draft: event.target.value, error: '' })}
          placeholder="MC-99636" />
        {parameters?.error && <p id="card-parameters-error" className="parameter-error" role="alert">{parameters.error}</p>}
        <div className="dialog-actions">
          {parameters && tree.nodes.get(parameters.id)?.targetTrackerKey && <button type="button" className="delete-button" onClick={() => {
            if (run(() => session.commands.setTrackerLink(parameters.id, null))) {
              setParameters(null)
              setMessage('Ссылка карточки удалена.')
              focusCanvas()
            }
          }}>Удалить ссылку</button>}
          <span className="dialog-actions-spacer" />
          <button type="button" onClick={closeParameters}>Отмена</button>
          <button type="submit">Сохранить</button>
        </div>
      </form>
    </dialog>
    <dialog ref={textConflictDialog} className="diagrams-dialog text-conflict-dialog confirmation-dialog"
      aria-labelledby="text-conflict-heading" onCancel={event => { event.preventDefault(); continueTextEdit() }}>
      <h2 id="text-conflict-heading">Текст карточки изменён</h2>
      <p>Другой участник сохранил изменения, пока у тебя был открыт черновик. Выбери, какую версию оставить.</p>
      <div className="text-conflict-versions">
        <section><h3>Актуальный текст</h3><div>{textConflict ? tree.nodes.get(textConflict)?.text : ''}</div></section>
        <section><h3>Твой черновик</h3><div>{edit?.draft ?? ''}</div></section>
      </div>
      <div className="dialog-actions">
        <button className="danger-button" onClick={overwriteCurrentText}>Заменить своим текстом</button>
        <span className="dialog-actions-spacer" />
        <button onClick={keepCurrentText}>Оставить актуальный текст</button>
        <button autoFocus onClick={continueTextEdit}>Продолжить редактирование</button>
      </div>
    </dialog>
    <main ref={canvas} className="canvas" tabIndex={0} onKeyDown={keyDown}
      onCopy={copyToClipboard} onCut={cutToClipboard} onPaste={pasteFromClipboard} inert={switching}
      aria-label="Дерево декомпозиции" aria-describedby="keyboard-status" data-diagram-id={session.id} data-ready={String(ready && layoutReady && !switching)}>
      {ready ? <ReactFlow<FlowCell> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        style={{ opacity: layoutReady ? 1 : 0, pointerEvents: layoutReady ? 'auto' : 'none' }}
        nodesConnectable={false} nodesFocusable={false} edgesFocusable={false}
        onNodeDragStart={startDrag} onNodeDrag={moveDrag} onNodeDragStop={stopDrag}
        nodeDragThreshold={5} autoPanOnNodeDrag={false} zoomOnDoubleClick={false}
        disableKeyboardA11y deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        minZoom={0.2} maxZoom={1.6} proOptions={{ hideAttribution: false }}
        onNodeClick={(_event, node) => {
          if (node.id !== editRef.current?.id && commit()) { setActive(node.id); focusCanvas() }
        }}
        onNodeDoubleClick={(_event, node) => startEdit(node.id)}
        onPaneClick={() => { if (commit()) focusCanvas() }}>
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
          ...(session.tracker ? [['F4', 'Параметры карточки'], ['Ctrl + Enter', 'Перейти к связанной задаче']] : []),
          ['Space', 'Открыто / готово'], ['Delete', 'Удалить поддерево'],
          ['Ctrl + C / X / V', 'Копировать / вырезать / вставить поддерево'],
          ['Enter / Ctrl + Enter', 'В редакторе: сохранить'], ['Esc в редакторе', 'Отменить draft'],
          ['Shift + Enter', 'В редакторе: перенос строки'],
          ['Esc на схеме', 'Вернуться к панели действий'],
          ['Ctrl + Z', 'Отменить действие'], ['Ctrl + Shift + Z / Y', 'Повторить действие'],
          ['Ctrl + O', 'Выбрать схему для редактирования'],
          ['Ctrl + S', 'Сохранить схему в файл'],
        ].map(([key, label]) => <div className="help-row" key={key}><span>{label}</span><kbd>{key}</kbd></div>)}
        <p>Мышью: клик активирует карточку. Тяни активную карточку на другую, чтобы сделать её дочерней, или к краю карточки, чтобы выбрать место среди соседей. Неактивная карточка перемещает холст без смены выделения. Esc отменяет перенос.</p>
        <p>На macOS вместо Ctrl можно использовать ⌘. Текст клеточки сохраняется целиком.</p>
        <p>В редакторе undo/redo меняет только draft. На схеме — твои действия в этой вкладке. После перезагрузки история очищается.</p>
        <button onClick={() => { setHelp(false); focusCanvas() }}>Вернуться к схеме</button>
      </aside>}
    </main>
    <div id="keyboard-status" className="sr-only" role="status">{message}</div>
  </>
}
