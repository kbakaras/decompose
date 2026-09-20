import type * as Y from 'yjs'
import { projectTree } from '../domain/projection'
import { readTextAlign, type TextAlign } from '../domain/schema'
import { ImportError, validateImport, type ImportNode } from './diagram-import'

export const DIAGRAM_FILE_LIMIT = 5 * 1024 * 1024
export interface DiagramFile {
  format: 'decompose'
  version: 1
  nodes: ImportNode[]
  settings: { textAlign: TextAlign }
}

export function validateDiagramFile(value: unknown): DiagramFile {
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 'decompose'
    || !('version' in value) || value.version !== 1) throw new ImportError('Неизвестный формат или версия файла дерево·дел.')
  if (new TextEncoder().encode(JSON.stringify(value)).length > DIAGRAM_FILE_LIMIT) throw new ImportError('Файл превышает 5 МиБ.')
  const { nodes } = validateImport(value, Infinity)
  const settings = 'settings' in value ? value.settings : null
  if (!settings || typeof settings !== 'object' || !('textAlign' in settings)
    || (settings.textAlign !== 'left' && settings.textAlign !== 'center')) throw new ImportError('Некорректное выравнивание текста в файле.')
  return { format: 'decompose', version: 1, nodes, settings: { textAlign: settings.textAlign } }
}

export function parseDiagramFile(text: string): DiagramFile {
  if (new TextEncoder().encode(text).length > DIAGRAM_FILE_LIMIT) throw new ImportError('Файл превышает 5 МиБ.')
  let value: unknown
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new ImportError('Не удалось прочитать JSON схемы.') }
  return validateDiagramFile(value)
}

export function snapshotDiagram(doc: Y.Doc): DiagramFile {
  const tree = projectTree(doc)
  const nodes: ImportNode[] = []
  const pending: string[] = [tree.rootId]
  while (pending.length) {
    const id = pending.pop()!
    const node = tree.nodes.get(id)!
    const children = [...(tree.children.get(id) ?? [])]
    nodes.push({ id, text: node.text, status: node.status, children })
    pending.push(...children.slice().reverse())
  }
  return { format: 'decompose', version: 1, nodes, settings: { textAlign: readTextAlign(doc) } }
}

export function serializeDiagram(doc: Y.Doc): string {
  const text = JSON.stringify(snapshotDiagram(doc), null, 2) + '\n'
  if (new TextEncoder().encode(text).length > DIAGRAM_FILE_LIMIT) throw new ImportError('Схема превышает лимит файла 5 МиБ. Данные не обрезаны.')
  return text
}

export function diagramFilename(title: string): string {
  const stem = title.trim().replace(/(?:\.decompose\.json|\.deco|\.json)+$/i, '')
  const name = stem.replace(/\s+/g, ' ').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 100).replace(/[. ]+$/, '')
  return `${name || 'Схема'}.deco`
}
