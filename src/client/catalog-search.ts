import type { KeyboardEvent } from 'react'
import type { CatalogListHandle } from './CatalogList'

export function catalogSearchKeyDown(event: KeyboardEvent<HTMLInputElement>, {
  list, createButton, openFirst, loading,
}: {
  list: CatalogListHandle | null
  createButton: HTMLButtonElement | null
  openFirst?: () => void
  loading: boolean
}) {
  if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    list?.focusEdge(event.key === 'ArrowDown' ? 'first' : 'last')
  } else if (!event.repeat) {
    if (openFirst) openFirst()
    else if (!loading && createButton && !createButton.disabled) createButton.focus()
  }
}

export function preventRepeatedEnter(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' && event.repeat) event.preventDefault()
}
