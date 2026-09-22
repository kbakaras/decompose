import { memo, useEffect, useRef, type MouseEvent } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { appUrl } from './app-url'

export interface ActivityCardData extends Record<string, unknown> {
  label: string
  kind: 'root' | 'mode' | 'resource' | 'participant'
  route?: string
  owner: boolean
  hasParent: boolean
  hasChildren: boolean
  positioned: boolean
  connectionId?: string
  onMeasure: (id: string, height: number) => void
  onNavigate: (route: string) => void
}

export type ActivityFlowCard = Node<ActivityCardData, 'activity'>

export const ActivityCard = memo(function ActivityCard({ id, data }: NodeProps<ActivityFlowCard>) {
  const element = useRef<HTMLDivElement>(null)
  const { onMeasure } = data
  useEffect(() => {
    if (!element.current) return
    const observer = new ResizeObserver(entries => {
      const height = entries[0]?.borderBoxSize[0]?.blockSize
      if (height) onMeasure(id, Math.ceil(height))
    })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [id, onMeasure])

  return <div ref={element}
    className={`cell activity-card ${data.kind === 'participant' ? 'activity-participant' : ''} ${data.owner ? 'activity-owner' : ''} ${data.route ? 'cell-linked' : ''}`}
    data-layout-ready={String(data.positioned)} data-activity-kind={data.kind}
    data-activity-connection={data.connectionId ?? ''}
    aria-label={data.owner ? `${data.label}. Владелец файла` : data.label}>
    {data.hasParent && <Handle type="target" position={Position.Left} isConnectable={false} />}
    <div className="cell-text">{data.label}</div>
    {data.route && <a className="cell-link nodrag nopan" href={appUrl(data.route).href}
      aria-label={`Открыть схему «${data.label}»`}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.stopPropagation()
        if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
          event.preventDefault()
          data.onNavigate(data.route!)
        }
      }} onAuxClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
        <path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" />
      </svg>
    </a>}
    {data.hasChildren && <Handle type="source" position={Position.Right} isConnectable={false} />}
  </div>
})
