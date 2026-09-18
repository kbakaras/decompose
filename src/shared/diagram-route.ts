import { isDiagramId } from './diagrams'
import { normalizeTrackerKey } from './tracker'

export type DiagramRoute = { kind: 'diagram'; id: string } | { kind: 'tracker'; key: string }

export function parseDiagramRoute(url: URL, base: URL = new URL('/', url)): DiagramRoute {
  if (url.origin !== base.origin || !base.pathname.endsWith('/') || !url.pathname.startsWith(base.pathname)) {
    throw new Error('Ссылка выходит за пределы приложения')
  }
  const path = url.pathname.slice(base.pathname.length)
  if (path === '' || path === 'index.html') {
    const id = url.searchParams.get('diagram') ?? 'main'
    if (isDiagramId(id)) return { kind: 'diagram', id }
  } else {
    const match = /^tracker\/([^/]+)\/?$/.exec(path)
    if (match) {
      let key: string | null = null
      try { key = normalizeTrackerKey(decodeURIComponent(match[1])) } catch { /* Некорректное кодирование URL. */ }
      if (key) return { kind: 'tracker', key }
    }
  }
  throw new Error('Некорректная ссылка на схему или ключ задачи')
}
