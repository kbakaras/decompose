import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'

export interface CatalogListHandle { focusEdge(edge: 'first' | 'last'): void }

export function CatalogList({ ref, label, items, currentId, disabled = false, navigate }: {
  ref?: Ref<CatalogListHandle>
  label: string
  items: { id: string; title: string; href: string }[]
  currentId?: string
  disabled?: boolean
  navigate: (href: string) => void
}) {
  const list = useRef<HTMLElement>(null)
  const hadFocus = useRef(false)
  const [focusedId, setFocusedId] = useState(currentId)
  const tabStop = items.find(item => item.id === focusedId)?.id
    ?? items.find(item => item.id === currentId)?.id ?? items[0]?.id

  useImperativeHandle(ref, () => ({ focusEdge(edge) {
    if (disabled) return
    const links = list.current?.querySelectorAll<HTMLAnchorElement>('a[href]')
    links?.[edge === 'first' ? 0 : links.length - 1]?.focus()
  } }), [disabled])

  useLayoutEffect(() => {
    const element = list.current
    // Обновление выдачи не крадёт фокус у поиска, но не теряет его при удалении строки.
    if (!element || !hadFocus.current || disabled) return
    if (document.activeElement === element || !element.contains(document.activeElement)) {
      (element.querySelector<HTMLAnchorElement>('a[tabindex="0"]') ?? element).focus()
    }
  }, [items, tabStop, disabled])

  return <nav ref={list} aria-label={label} className="diagrams-list" tabIndex={-1}
    onFocusCapture={() => { hadFocus.current = true }}
    onBlurCapture={event => { hadFocus.current = event.currentTarget.contains(event.relatedTarget) }}>
    {items.map((item, index) => <a key={item.id} href={item.href}
      aria-current={item.id === currentId ? 'page' : undefined} aria-disabled={disabled || undefined}
      tabIndex={!disabled && item.id === tabStop ? 0 : -1} onFocus={() => setFocusedId(item.id)}
      onKeyDown={event => {
        if (disabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        let next: number
        if (event.key === 'ArrowDown') next = Math.min(index + 1, items.length - 1)
        else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0)
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = items.length - 1
        else return
        event.preventDefault()
        event.stopPropagation()
        list.current?.querySelectorAll<HTMLAnchorElement>('a[href]')[next]?.focus()
      }} onClick={event => {
        if (disabled) { event.preventDefault(); return }
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return
        event.preventDefault()
        navigate(item.href)
      }}>
      <span>{item.title}</span>{item.id === currentId && <small>Открыта</small>}
    </a>)}
  </nav>
}
