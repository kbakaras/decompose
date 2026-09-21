export interface DiagramSummary { id: string; title: string; trackerKey?: string }

export function normalizeTitle(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim()
}

export function diagramTitle(text: string, trackerKey?: string): string {
  return normalizeTitle(text) || trackerKey || 'Новая декомпозиция'
}

export function isDiagramId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

export function diagramUrl(id: string): string {
  return `diagram/${encodeURIComponent(id)}`
}
