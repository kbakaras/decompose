import type * as Y from 'yjs'
import { projectTree } from '../domain/projection'
import {
  getStructures,
  normalizeUpdateAuthor,
  readContentRevision,
  readStatusRestore,
  readTextAlign,
  type NodeUpdate,
  type StatusRestore,
  type TextAlign,
} from '../domain/schema'
import { ImportError, validateImport, type ImportNode } from './diagram-import'
import { createUuid } from './uuid'

export const DIAGRAM_FILE_LIMIT = 5 * 1024 * 1024
export interface DiagramFileNode extends ImportNode {
  updated?: NodeUpdate
  contentRevision?: string
  statusRestore?: StatusRestore
}

export interface DiagramFile {
  format: 'decompose'
  version: 2
  nodes: DiagramFileNode[]
  settings: { textAlign: TextAlign }
}

export function validateDiagramFile(value: unknown): DiagramFile {
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 'decompose'
    || !('version' in value) || (value.version !== 1 && value.version !== 2)) throw new ImportError('Неизвестный формат или версия файла дерево·дел.')
  if (new TextEncoder().encode(JSON.stringify(value)).length > DIAGRAM_FILE_LIMIT) throw new ImportError('Файл превышает 5 МиБ.')
  const tree = validateImport(value, Infinity)
  if (tree.rootId !== 'root') throw new ImportError('Корневой узел файла дерево·дел должен иметь ID root.')
  const settings = 'settings' in value ? value.settings : null
  if (!settings || typeof settings !== 'object' || !('textAlign' in settings)
    || (settings.textAlign !== 'left' && settings.textAlign !== 'center')) throw new ImportError('Некорректное выравнивание текста в файле.')
  const byId = new Map(tree.nodes.map(node => [node.id, node]))
  const sourceNodes = 'nodes' in value && Array.isArray(value.nodes) ? value.nodes : []
  const sourceById = new Map(sourceNodes.map(source => [
    source && typeof source === 'object' && 'id' in source ? source.id : null,
    source,
  ]))
  const nodes: DiagramFileNode[] = []
  const pending = [tree.rootId]
  while (pending.length) {
    const node = byId.get(pending.pop()!)!
    let metadata: Pick<DiagramFileNode, 'updated' | 'contentRevision' | 'statusRestore'> = {}
    if (value.version === 2) metadata = validateNodeMetadata(sourceById.get(node.id))
    nodes.push({ ...node, ...metadata })
    pending.push(...node.children.slice().reverse())
  }
  return { format: 'decompose', version: 2, nodes, settings: { textAlign: settings.textAlign } }
}

function validateNodeMetadata(value: unknown): Pick<DiagramFileNode, 'updated' | 'contentRevision' | 'statusRestore'> {
  if (!value || typeof value !== 'object') throw new ImportError('Некорректные метаданные карточки.')
  const result: Pick<DiagramFileNode, 'updated' | 'contentRevision' | 'statusRestore'> = {}
  if ('updated' in value && value.updated !== undefined) result.updated = validateUpdate(value.updated)
  if ('contentRevision' in value && value.contentRevision !== undefined) {
    if (!isUuid(value.contentRevision)) throw new ImportError('Некорректная ревизия текста карточки.')
    result.contentRevision = value.contentRevision
  }
  if ('statusRestore' in value && value.statusRestore !== undefined) {
    const restore = value.statusRestore
    if (!restore || typeof restore !== 'object' || !('status' in restore) || !('updated' in restore)
      || !('contentRevision' in restore) || (restore.status !== 'open' && restore.status !== 'done')
      || !isUuid(restore.contentRevision)) throw new ImportError('Некорректное состояние возврата статуса карточки.')
    result.statusRestore = {
      status: restore.status,
      updated: restore.updated === null ? null : validateUpdate(restore.updated),
      contentRevision: restore.contentRevision,
    }
  }
  return result
}

function validateUpdate(value: unknown): NodeUpdate {
  if (!value || typeof value !== 'object' || !('at' in value) || !('by' in value)) {
    throw new ImportError('Некорректные сведения об изменении карточки.')
  }
  const by = normalizeUpdateAuthor(value.by)
  const at = typeof value.at === 'number' ? value.at : NaN
  if (!Number.isSafeInteger(at) || at < 0 || !by) {
    throw new ImportError('Некорректные сведения об изменении карточки.')
  }
  return { at, by }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function sameDiagramFile(first: DiagramFile, second: DiagramFile): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}

export function parseDiagramFile(text: string): DiagramFile {
  if (new TextEncoder().encode(text).length > DIAGRAM_FILE_LIMIT) throw new ImportError('Файл превышает 5 МиБ.')
  let value: unknown
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new ImportError('Не удалось прочитать JSON схемы.') }
  return validateDiagramFile(value)
}

export function snapshotDiagram(doc: Y.Doc): DiagramFile {
  const tree = projectTree(doc)
  const rawNodes = getStructures(doc).nodes
  const nodes: DiagramFileNode[] = []
  const pending: string[] = [tree.rootId]
  while (pending.length) {
    const id = pending.pop()!
    const node = tree.nodes.get(id)!
    const children = [...(tree.children.get(id) ?? [])]
    const raw = rawNodes.get(id)
    const contentRevision = raw && readContentRevision(raw)
    const statusRestore = raw && readStatusRestore(raw)
    nodes.push({ id, text: node.text, status: node.status, children,
      ...(node.targetTrackerKey ? { targetTrackerKey: node.targetTrackerKey } : {}),
      ...(node.updated ? { updated: node.updated } : {}),
      ...(contentRevision ? { contentRevision } : {}),
      ...(statusRestore ? { statusRestore } : {}),
    })
    pending.push(...children.slice().reverse())
  }
  return { format: 'decompose', version: 2, nodes, settings: { textAlign: readTextAlign(doc) } }
}

export function stampDiagramMetadata(
  file: DiagramFile,
  author: string,
  at = Date.now(),
  createId = createUuid,
): DiagramFile {
  const by = normalizeUpdateAuthor(author)
  if (!by || !Number.isSafeInteger(at) || at < 0) throw new ImportError('Некорректный автор или дата импорта.')
  return {
    ...file,
    nodes: file.nodes.map(node => ({
      ...node,
      updated: { at, by },
      contentRevision: createId(),
      statusRestore: undefined,
    })),
  }
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
