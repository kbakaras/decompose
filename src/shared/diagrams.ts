export interface DiagramSummary { id: string; title: string }

export function isDiagramId(value: unknown): value is string {
  return typeof value === 'string' && (value === 'main'
    || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
}

export function diagramUrl(id: string): string {
  return `/?diagram=${encodeURIComponent(id)}`
}
