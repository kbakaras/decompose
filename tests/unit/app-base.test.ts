import { expect, it } from 'vitest'
import { relativeAppRoot, resolveAppUrl, setHtmlBase } from '../../src/shared/app-base'
import { parseDiagramRoute } from '../../src/shared/diagram-route'
import { diagramUrl } from '../../src/shared/diagrams'
import { trackerUrl } from '../../src/shared/tracker'

it.each([
  ['/', './'], ['/index.html', './'], ['/tracker/MC-1', '../'], ['/tracker/MC-1/', '../../'],
])('computes a prefix-independent HTML base for %s', (path, expected) => {
  expect(relativeAppRoot(path)).toBe(expected)
  const html = '<head><base href="./" data-app-base /><script src="./assets/app.js"></script></head>'
  expect(setHtmlBase(html, relativeAppRoot(path))).toContain(`<base href="${expected}" data-app-base`)
  for (const mount of ['http://localhost:3000/', 'http://gateway.test/decompose/', 'https://gateway.test:8443/tools/tree/']) {
    const page = new URL(path.slice(1), mount)
    expect(new URL(relativeAppRoot(path), page).href).toBe(mount)
  }
})

it('rejects missing HTML markers and unsafe base substitutions', () => {
  expect(() => setHtmlBase('<head></head>', './')).toThrow()
  for (const base of ['/', '//host/', 'https://host/', '" onload="alert(1)', 'decompose/']) {
    expect(() => setHtmlBase('<base href="./" data-app-base>', base)).toThrow()
  }
})

it.each(['http://localhost:3000/', 'http://gateway.test/decompose/', 'https://gateway.test:8443/tools/tree/'])('keeps API and routes within %s', base => {
  expect(resolveAppUrl('api/diagrams', base).href).toBe(base + 'api/diagrams')
  expect(resolveAppUrl('./', base).href).toBe(base)
  expect(parseDiagramRoute(resolveAppUrl(diagramUrl('main'), base), new URL(base))).toEqual({ kind: 'diagram', id: 'main' })
  expect(parseDiagramRoute(resolveAppUrl(trackerUrl('mc-99636'), base), new URL(base))).toEqual({ kind: 'tracker', key: 'MC-99636' })
  expect(parseDiagramRoute(resolveAppUrl('tracker/MC-1/', base), new URL(base))).toEqual({ kind: 'tracker', key: 'MC-1' })
  expect(parseDiagramRoute(resolveAppUrl('index.html?diagram=main', base), new URL(base))).toEqual({ kind: 'diagram', id: 'main' })
})

it('rejects other origins and similar but nonmatching path prefixes', () => {
  const base = new URL('https://gateway.test/decompose/')
  for (const path of ['/api/diagrams', '//other.test/api', '../api', 'https://other.test/', '\\api']) {
    expect(() => resolveAppUrl(path, base)).toThrow()
  }
  for (const url of ['https://gateway.test/decompose-other/', 'https://gateway.test/tracker/MC-1', 'https://other.test/decompose/']) {
    expect(() => parseDiagramRoute(new URL(url), base)).toThrow()
  }
})
