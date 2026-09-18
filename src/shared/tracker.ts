import { isDiagramId, normalizeTitle, type DiagramSummary } from './diagrams'

export interface TrackerSummary extends DiagramSummary { trackerKey: string; updatedAt: number }
export interface TrackerPage { items: TrackerSummary[]; nextOffset: number | null }
export const TRACKER_PAGE_SIZE = 20

export function normalizeTrackerKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null
  return /^[a-z][a-z0-9]*-[0-9]+$/i.test(value) ? value.toUpperCase() : null
}

export function isTrackerSummary(value: unknown): value is TrackerSummary {
  if (!value || typeof value !== 'object') return false
  const item = value as TrackerSummary
  return isDiagramId(item.id) && item.id !== 'main' && typeof item.title === 'string'
    && typeof item.trackerKey === 'string' && normalizeTrackerKey(item.trackerKey) === item.trackerKey
    && Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0
}

export function trackerUrl(key: string): string { return `tracker/${encodeURIComponent(key)}` }
export function trackerSearch(text: string): string { return normalizeTitle(text).toLowerCase() }
export function trackerLabel(title: string, key?: string): string {
  return key && title && title !== key ? `${key} · ${title}` : title || key || ''
}
