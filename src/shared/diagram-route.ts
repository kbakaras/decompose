import { isDiagramId } from './diagrams'
import { normalizeTrackerKey } from './tracker'

export type DiagramRoute = { kind: 'diagram'; id: string } | { kind: 'tracker'; key: string }

export function parseDiagramRoute(url: URL): DiagramRoute {
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const id = url.searchParams.get('diagram') ?? 'main'
    if (isDiagramId(id)) return { kind: 'diagram', id }
  } else {
    const match = /^\/tracker\/([^/]+)\/?$/.exec(url.pathname)
    if (match) {
      let key: string | null = null
      try { key = normalizeTrackerKey(decodeURIComponent(match[1])) } catch { /* Некорректное кодирование URL. */ }
      if (key) return { kind: 'tracker', key }
    }
  }
  throw new Error('Некорректная ссылка на схему или ключ задачи')
}
