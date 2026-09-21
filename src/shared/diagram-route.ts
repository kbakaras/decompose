import { diagramUrl, isDiagramId } from './diagrams'
import { normalizeTrackerKey, trackerUrl } from './tracker'

export type DiagramRoute = { kind: 'home' } | { kind: 'diagram'; id: string } | { kind: 'tracker'; key: string } | { kind: 'file'; id: string } | { kind: 'local-file'; id: string }

export const localFileUrl = (id: string) => `file/local/${encodeURIComponent(id)}`
export const fileSessionUrl = (id: string) => `file/session/${encodeURIComponent(id)}`

/** Старые параметры выбирают документ только в корне; остальные параметры и hash сохраняются. */
export function canonicalDiagramUrl(url: URL, base: URL): URL {
  const route = parseDiagramRoute(url, base)
  const canonical = new URL(url)
  const path = route.kind === 'home' ? './' : route.kind === 'diagram' ? diagramUrl(route.id)
    : route.kind === 'tracker' ? trackerUrl(route.key)
      : route.kind === 'local-file' ? localFileUrl(route.id) : fileSessionUrl(route.id)
  canonical.pathname = new URL(path, base).pathname
  for (const key of ['diagram', 'localFile', 'fileSession']) canonical.searchParams.delete(key)
  return canonical
}

export function parseDiagramRoute(url: URL, base: URL = new URL('/', url)): DiagramRoute {
  if (url.origin !== base.origin || !base.pathname.endsWith('/') || !url.pathname.startsWith(base.pathname)) {
    throw new Error('Ссылка выходит за пределы приложения')
  }
  const path = url.pathname.slice(base.pathname.length)
  if (path === '' || path === 'index.html') {
    if (url.searchParams.has('fileSession')) {
      const id = url.searchParams.get('fileSession')
      if (isDiagramId(id)) return { kind: 'file', id }
      throw new Error('Некорректная ссылка файловой сессии')
    }
    if (url.searchParams.has('localFile')) {
      const id = url.searchParams.get('localFile')
      if (id === '1' || isDiagramId(id)) return { kind: 'local-file', id: id! }
      throw new Error('Некорректная ссылка на локальный файл')
    }
    if (!url.searchParams.has('diagram')) return { kind: 'home' }
    const id = url.searchParams.get('diagram')
    if (isDiagramId(id)) return { kind: 'diagram', id }
  } else {
    const diagram = /^diagram\/([^/]+)\/?$/.exec(path)
    if (diagram && isDiagramId(diagram[1])) return { kind: 'diagram', id: diagram[1] }
    const file = /^file\/(local|session)\/([^/]+)\/?$/.exec(path)
    if (file && (file[2] === '1' ? file[1] === 'local' : isDiagramId(file[2]))) {
      return { kind: file[1] === 'local' ? 'local-file' : 'file', id: file[2] }
    }
    const match = /^tracker\/([^/]+)\/?$/.exec(path)
    if (match) {
      let key: string | null = null
      try { key = normalizeTrackerKey(decodeURIComponent(match[1])) } catch { /* Некорректное кодирование URL. */ }
      if (key) return { kind: 'tracker', key }
    }
  }
  throw new Error('Схема не найдена или ссылка некорректна')
}
