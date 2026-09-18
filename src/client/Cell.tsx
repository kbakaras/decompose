import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react'
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
  const editingBy = data.others.filter(person => person.editingNode === node.id).map(person => person.name).join(', ')
  const details = [
    node.status === 'done' ? 'Готово' : 'Открыто',
    ...data.others.map(person => `${person.name}: ${person.editingNode === node.id ? 'редактирует' : 'выбрана клеточка'}`),
    node.recovered ? 'Перемещено после объединения изменений' : '',
  ].filter(Boolean).join('. ')
  return <div ref={element}
    className={`cell ${data.active ? 'cell-active' : ''} ${node.status === 'done' ? 'cell-done' : ''} ${editing ? 'cell-editing' : ''} ${data.dropSide ? `cell-drop-${data.dropSide}` : ''} ${data.dragging ? 'cell-dragging' : ''} ${draggable ? 'cell-draggable' : ''} ${data.others.length ? 'cell-with-presence' : ''}`}
    style={{ '--presence-color': data.others[0]?.color, '--cell-text-align': data.textAlign } as CSSProperties}
    data-layout-ready={String(data.positioned)}
    data-cell-id={node.id} data-parent-id={node.parentId ?? ''} data-order={data.index}
    data-status={node.status} data-active={String(data.active)} data-text={node.text}
    data-editing-by={editingBy} title={details} aria-label={`${text}. ${details}`}>
    {node.parentId !== null && <Handle type="target" position={Position.Left} />}
    {editing ? <textarea ref={editor} className="nodrag nopan nowheel cell-editor" aria-label="Текст клеточки"
      value={edit.draft} rows={1} onChange={event => data.onDraft(event.target.value)}
      onKeyDown={data.onEditorKey} onBlur={data.onCommit} spellCheck />
      : <div className="cell-text">{node.text}</div>}
    <Handle type="source" position={Position.Right} />
  </div>
})
