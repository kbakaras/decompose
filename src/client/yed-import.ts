import { ImportError, IMPORT_FILE_LIMIT, IMPORT_JSON_LIMIT, IMPORT_NODE_LIMIT, validateImport, type ImportNode } from '../shared/diagram-import'

const graphml = 'http://graphml.graphdrawing.org/xmlns'
const yworks = 'http://www.yworks.com/xml/graphml'
const direct = (element: Element, namespace: string, name: string) =>
  Array.from(element.children).filter(child => child.namespaceURI === namespace && child.localName === name)

export function isGreenFill(color: string | null): boolean {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return false
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16))
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  if (!max || delta / max < 0.2) return false
  const hue = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360
  return hue >= 70 && hue <= 170
}

export function parseYedGraphml(xml: string): { nodes: ImportNode[] } {
  if (new TextEncoder().encode(xml).length > IMPORT_FILE_LIMIT) throw new ImportError('Файл превышает 5 МиБ.')
  // Не допускаем DTD до XML-парсинга, включая внутренние/внешние сущности.
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)) throw new ImportError('DTD и объявления сущностей не поддерживаются.')
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (document.getElementsByTagNameNS('*', 'parsererror').length) throw new ImportError('Некорректный XML в файле GraphML.')
  const root = document.documentElement
  if (root.namespaceURI !== graphml || root.localName !== 'graphml') throw new ImportError('Ожидается файл GraphML из yEd.')
  if (Array.from(root.children).some(child => child.namespaceURI !== graphml || !['key', 'graph', 'data', 'desc'].includes(child.localName))) {
    throw new ImportError('Неподдерживаемая структура GraphML.')
  }
  const graphs = document.getElementsByTagNameNS(graphml, 'graph')
  if (graphs.length !== 1 || graphs[0].parentElement !== root) throw new ImportError('Нужен один граф без групп и вложенных графов.')
  const graph = graphs[0]
  if (!['directed', 'undirected'].includes(graph.getAttribute('edgedefault') ?? '')) throw new ImportError('Не задано направление связей графа.')
  for (const element of Array.from(graph.children)) {
    if (element.namespaceURI !== graphml || !['node', 'edge', 'data', 'desc'].includes(element.localName)) {
      throw new ImportError('Гиперсвязи и другие структуры вне дерева не поддерживаются.')
    }
  }
  const keys = new Set<string>()
  const graphicsKeys = new Set<string>()
  for (const key of direct(root, graphml, 'key')) {
    const id = key.getAttribute('id')
    if (!id || keys.has(id)) throw new ImportError('Некорректные или повторяющиеся ключи GraphML.')
    keys.add(id)
    if (key.getAttribute('yfiles.type') === 'nodegraphics' && ['node', 'all'].includes(key.getAttribute('for') ?? 'all')) graphicsKeys.add(id)
  }
  const elements = direct(graph, graphml, 'node')
  if (!elements.length || elements.length > IMPORT_NODE_LIMIT) throw new ImportError(`Схема должна содержать от 1 до ${IMPORT_NODE_LIMIT} узлов.`)
  const centers = new Map<string, { x: number; y: number }>()
  const nodes = elements.map((element): ImportNode => {
    if (element.hasAttribute('yfiles.foldertype') || direct(element, graphml, 'port').length) throw new ImportError('Группы и порты узлов не поддерживаются.')
    if (Array.from(element.children).some(child => child.namespaceURI !== graphml || !['data', 'desc'].includes(child.localName))) {
      throw new ImportError('Неподдерживаемая структура узла GraphML.')
    }
    const data = direct(element, graphml, 'data').filter(item => graphicsKeys.has(item.getAttribute('key') ?? ''))
    const shapes = data.flatMap(item => Array.from(item.children))
    if (shapes.length !== 1 || shapes[0].namespaceURI !== yworks || !['ShapeNode', 'GenericNode'].includes(shapes[0].localName)) {
      throw new ImportError('Поддерживаются только узлы yEd ShapeNode и GenericNode.')
    }
    const shape = shapes[0]
    const geometry = direct(shape, yworks, 'Geometry')
    if (geometry.length !== 1) throw new ImportError('Для каждого узла требуется геометрия yEd.')
    const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => {
      const value = geometry[0].getAttribute(name)
      return value?.trim() ? Number(value) : NaN
    })
    if (![x, y, width, height, x + width / 2, y + height / 2].every(Number.isFinite) || width <= 0 || height <= 0) {
      throw new ImportError('Координаты узлов должны быть конечными, размеры — положительными.')
    }
    const id = element.getAttribute('id') ?? ''
    centers.set(id, { x: x + width / 2, y: y + height / 2 })
    const labels = direct(shape, yworks, 'NodeLabel')
    if (labels.length > 1) throw new ImportError('Узел с несколькими подписями не поддерживается.')
    const fills = direct(shape, yworks, 'Fill')
    const fill = fills.length === 1 ? fills[0] : undefined
    const singleColor = fill && !fill.hasAttribute('color2') && !['false', '0'].includes(fill.getAttribute('hasColor') ?? '')
      && [null, 'false', '0'].includes(fill.getAttribute('transparent'))
    return { id, text: labels[0]?.textContent?.trim() ?? '', status: singleColor && isGreenFill(fill.getAttribute('color')) ? 'done' : 'open', children: [] }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  const edgeIds = new Set<string>()
  for (const edge of direct(graph, graphml, 'edge')) {
    const id = edge.getAttribute('id')
    if (id !== null && edgeIds.has(id)) throw new ImportError('В схеме повторяются ID связей.')
    if (id !== null) edgeIds.add(id)
    const directed = edge.getAttribute('directed')
    if (!(directed === null ? graph.getAttribute('edgedefault') === 'directed' : ['true', '1'].includes(directed))) {
      throw new ImportError('Ненаправленные связи не поддерживаются. Нужна связь от родителя к ребёнку.')
    }
    if (edge.hasAttribute('sourceport') || edge.hasAttribute('targetport')) throw new ImportError('Связи через порты не поддерживаются.')
    const source = byId.get(edge.getAttribute('source') ?? '')
    const target = edge.getAttribute('target') ?? ''
    if (!source || !byId.has(target)) throw new ImportError('Связь ссылается на отсутствующий узел.')
    source.children.push(target)
  }
  for (const node of nodes) node.children.sort((a, b) => {
    const first = centers.get(a)!, second = centers.get(b)!
    return first.y - second.y || first.x - second.x || (a < b ? -1 : a > b ? 1 : 0)
  })
  const result = { nodes: validateImport({ nodes }).nodes }
  if (new TextEncoder().encode(JSON.stringify(result)).length > IMPORT_JSON_LIMIT) throw new ImportError('Данные схемы превышают 1 МиБ.')
  return result
}

export async function readYedFile(file: File): Promise<{ nodes: ImportNode[] }> {
  if (file.size > IMPORT_FILE_LIMIT) throw new ImportError('Файл превышает 5 МиБ.')
  return parseYedGraphml(await file.text())
}
