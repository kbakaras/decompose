import { isDiagramId } from './diagrams'

export function documentName(id: string, generation: number): string {
  return generation === 0 ? id : `${id}~${generation}`
}
export function parseDocumentName(name: string): { id: string; generation: number } | null {
  const [id, raw, extra] = name.split('~')
  if (!isDiagramId(id) || extra !== undefined || (raw !== undefined && !/^[1-9]\d*$/.test(raw))) return null
  const generation = raw === undefined ? 0 : Number(raw)
  return Number.isSafeInteger(generation) ? { id, generation } : null
}
