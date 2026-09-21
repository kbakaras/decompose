import { DIAGRAM_FILE_LIMIT } from '../shared/diagram-file'
import {
  SUBTREE_CLIPBOARD_FORMAT,
  captureSubtree,
  validateSubtreeSnapshot,
  type SubtreeSnapshot,
  type TreeProjection,
} from '../domain'

export const SUBTREE_CLIPBOARD_TYPE = 'application/x-decompose-subtree+json'
const HTML_ATTRIBUTE = 'data-decompose-subtree'

export function subtreeForClipboard(tree: TreeProjection, rootId: string): SubtreeSnapshot {
  return captureSubtree(tree, rootId)
}

export function serializeSubtree(snapshot: SubtreeSnapshot): string {
  const validated = validateSubtreeSnapshot(snapshot)
  const text = JSON.stringify(validated)
  if (new TextEncoder().encode(text).length > DIAGRAM_FILE_LIMIT) {
    throw new Error('Поддерево превышает лимит буфера 5 МиБ.')
  }
  return text
}

export function parseSerializedSubtree(text: string): SubtreeSnapshot {
  if (!text || new TextEncoder().encode(text).length > DIAGRAM_FILE_LIMIT) {
    throw new Error(text ? 'Поддерево превышает лимит буфера 5 МиБ.' : 'В буфере нет поддерева дерево·дел.')
  }
  try {
    return validateSubtreeSnapshot(JSON.parse(text))
  } catch (error) {
    if (error instanceof Error && error.message.includes('5 МиБ')) throw error
    throw new Error('В буфере нет корректного поддерева дерево·дел.')
  }
}

export function subtreeOutline(snapshot: SubtreeSnapshot): string {
  const validated = validateSubtreeSnapshot(snapshot)
  const nodes = new Map(validated.nodes.map(node => [node.id, node]))
  const lines: string[] = []
  const visit = (id: string, depth: number) => {
    const node = nodes.get(id)!
    const indent = '  '.repeat(depth)
    const textLines = (node.text || 'Пустая карточка').split('\n')
    lines.push(`${indent}${textLines[0]}`)
    for (const line of textLines.slice(1)) lines.push(`${indent}  ${line}`)
    for (const child of node.children) visit(child, depth + 1)
  }
  visit(validated.rootId, 0)
  return lines.join('\n')
}

export function writeSubtreeClipboard(clipboard: DataTransfer, snapshot: SubtreeSnapshot): void {
  const serialized = serializeSubtree(snapshot)
  const wrapper = document.createElement('div')
  wrapper.setAttribute(HTML_ATTRIBUTE, serialized)
  const outline = subtreeOutline(snapshot)
  wrapper.textContent = outline

  // Некоторые браузеры отбрасывают нестандартный MIME, поэтому HTML обязателен.
  try { clipboard.setData(SUBTREE_CLIPBOARD_TYPE, serialized) } catch { /* Используем HTML. */ }
  clipboard.setData('text/html', wrapper.outerHTML)
  clipboard.setData('text/plain', outline)
}

/**
 * Записывает структурный буфер из клавиатурного обработчика. Legacy-команда здесь
 * нужна для обычного HTTP, где асинхронный Clipboard API недоступен.
 */
export function copySubtreeToSystemClipboard(snapshot: SubtreeSnapshot): void {
  const input = document.createElement('textarea')
  input.value = subtreeOutline(snapshot)
  input.setAttribute('aria-hidden', 'true')
  input.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none'
  document.body.append(input)
  input.select()

  let written = false
  const write = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    writeSubtreeClipboard(event.clipboardData, snapshot)
    event.preventDefault()
    written = true
  }
  document.addEventListener('copy', write, { capture: true, once: true })
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    document.removeEventListener('copy', write, true)
    input.remove()
  }
  if (!copied || !written) throw new Error('Браузер не разрешил записать поддерево в буфер.')
}

export function readSubtreeClipboard(clipboard: DataTransfer): SubtreeSnapshot {
  const custom = clipboard.getData(SUBTREE_CLIPBOARD_TYPE)
  if (custom) {
    try { return parseSerializedSubtree(custom) } catch { /* Проверяем резервный HTML. */ }
  }
  const html = clipboard.getData('text/html')
  if (html) {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const serialized = document.querySelector(`[${HTML_ATTRIBUTE}]`)?.getAttribute(HTML_ATTRIBUTE)
    if (serialized) return parseSerializedSubtree(serialized)
  }
  throw new Error('В буфере нет поддерева дерево·дел.')
}
