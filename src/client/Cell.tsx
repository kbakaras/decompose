import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { ProjectedNode, TextAlign } from '../domain'
import type { Participant } from './session'

export interface EditState { id: string; draft: string; isNew: boolean }
export interface CellData extends Record<string, unknown> {
  node: ProjectedNode
  index: number
  active: boolean
  textAlign: TextAlign
  edit: EditState | null
  positioned: boolean
  dropSide: 'before' | 'after' | null
  dragging: boolean
  others: Participant[]
  onDraft: (text: string) => void
  onEditorKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onCommit: () => void
  onMeasure: (id: string, height: number) => void
  onFollowLink: (key: string) => void
}
export type FlowCell = Node<CellData, 'cell'>

export const Cell = memo(function Cell({ data, draggable }: NodeProps<FlowCell>) {
  const element = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const { node, edit, onMeasure } = data
  const editing = edit?.id === node.id
  useEffect(() => {
    if (!element.current) return
    const observer = new ResizeObserver(entries => {
      const height = entries[0]?.borderBoxSize[0]?.blockSize
      if (height) onMeasure(node.id, Math.ceil(height))
    })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [node.id, onMeasure])
  useLayoutEffect(() => {
    if (editing) {
      editor.current?.focus({ preventScroll: true })
      editor.current?.setSelectionRange(editor.current.value.length, editor.current.value.length)
    }
  }, [editing])
  useLayoutEffect(() => {
    if (editor.current) {
      editor.current.style.height = '0px'
      editor.current.style.height = `${editor.current.scrollHeight}px`
    }
  }, [editing, edit?.draft])

  const text = node.text || 'Пустая клеточка'
  const selectedBy = [...new Map(data.others
    .filter(person => person.activeNode === node.id && person.name)
    .map(person => [person.userId, person.name!])).values()]
    .sort((left, right) => left.localeCompare(right, 'ru')).join(', ')
  const editingBy = data.others.filter(person => person.editingNode === node.id).map(person => person.name).join(', ')
  const details = [
    node.status === 'done' ? 'Готово' : 'Открыто',
    ...data.others.map(person => `${person.name}: ${person.editingNode === node.id ? 'редактирует' : 'выбрана клеточка'}`),
    node.recovered ? 'Перемещено после объединения изменений' : '',
  ].filter(Boolean).join('. ')
  return <div ref={element}
    className={`cell ${data.active ? 'cell-active' : ''} ${node.status === 'done' ? 'cell-done' : ''} ${editing ? 'cell-editing' : ''} ${node.targetTrackerKey ? 'cell-linked' : ''} ${data.dropSide ? `cell-drop-${data.dropSide}` : ''} ${data.dragging ? 'cell-dragging' : ''} ${draggable ? 'cell-draggable' : ''} ${data.others.length ? 'cell-with-presence' : ''}`}
    style={{ '--presence-color': data.others[0]?.color, '--cell-text-align': data.textAlign } as CSSProperties}
    data-layout-ready={String(data.positioned)}
    data-cell-id={node.id} data-parent-id={node.parentId ?? ''} data-order={data.index}
    data-status={node.status} data-active={String(data.active)} data-text={node.text} data-tracker-link={node.targetTrackerKey ?? ''}
    data-editing-by={editingBy} title={selectedBy || undefined} aria-label={`${text}. ${details}`}>
    {node.parentId !== null && <Handle type="target" position={Position.Left} isConnectable={false} />}
    {editing ? <textarea ref={editor} className="nodrag nopan nowheel cell-editor" aria-label="Текст клеточки"
      value={edit.draft} rows={1} onChange={event => data.onDraft(event.target.value)}
      onKeyDown={data.onEditorKey} onBlur={data.onCommit} spellCheck />
      : <div className="cell-text">{node.text}</div>}
    {node.targetTrackerKey && !editing && <a className="cell-link nodrag nopan" href={`tracker/${encodeURIComponent(node.targetTrackerKey)}`}
      aria-label={`Открыть задачу ${node.targetTrackerKey}`}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.stopPropagation()
        if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
          event.preventDefault()
          data.onFollowLink(node.targetTrackerKey!)
        }
      }} onAuxClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
        <path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" />
      </svg>
    </a>}
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>
})
