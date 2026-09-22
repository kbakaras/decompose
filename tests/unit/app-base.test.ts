import { expect, it } from 'vitest'
import { relativeAppRoot, resolveAppUrl, setHtmlBase } from '../../src/shared/app-base'
import { activityUrl, canonicalDiagramUrl, fileSessionUrl, localFileUrl, parseDiagramRoute } from '../../src/shared/diagram-route'
import { diagramUrl } from '../../src/shared/diagrams'
import { trackerUrl } from '../../src/shared/tracker'

it.each([
  ['/', './'], ['/index.html', './'], ['/tracker/MC-1', '../'], ['/tracker/MC-1/', '../../'],
  ['/diagram/main', '../'], ['/diagram/main/', '../../'], ['/activity', './'], ['/activity/', '../'],
  ['/file/local/id', '../../'], ['/file/session/id/', '../../../'],
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
  const id = '5e155b04-31db-4117-a0ca-1e3e4d8cfd26'
  expect(parseDiagramRoute(resolveAppUrl(diagramUrl(id), base), new URL(base))).toEqual({ kind: 'diagram', id })
  expect(parseDiagramRoute(resolveAppUrl(trackerUrl('mc-99636'), base), new URL(base))).toEqual({ kind: 'tracker', key: 'MC-99636' })
  expect(parseDiagramRoute(resolveAppUrl('tracker/MC-1/', base), new URL(base))).toEqual({ kind: 'tracker', key: 'MC-1' })
  expect(parseDiagramRoute(resolveAppUrl('index.html', base), new URL(base))).toEqual({ kind: 'home' })
  expect(parseDiagramRoute(resolveAppUrl(activityUrl(), base), new URL(base))).toEqual({ kind: 'activity' })
  expect(parseDiagramRoute(resolveAppUrl(`./?localFile=${id}`, base), new URL(base))).toEqual({ kind: 'local-file', id })
  expect(parseDiagramRoute(resolveAppUrl(`./?fileSession=${id}`, base), new URL(base))).toEqual({ kind: 'file', id })
  expect(parseDiagramRoute(resolveAppUrl(localFileUrl(id), base), new URL(base))).toEqual({ kind: 'local-file', id })
  expect(parseDiagramRoute(resolveAppUrl(fileSessionUrl(id), base), new URL(base))).toEqual({ kind: 'file', id })
  expect(parseDiagramRoute(resolveAppUrl('./?localFile=1', base), new URL(base))).toEqual({ kind: 'local-file', id: '1' })
  for (const query of ['localFile=', 'localFile=main', 'fileSession=main']) {
    expect(() => parseDiagramRoute(resolveAppUrl(`./?${query}`, base), new URL(base))).toThrow()
  }
})

it.each(['http://localhost:3000/', 'https://gateway.test/tools/tree/'])('canonicalizes old links without losing extra parameters at %s', mount => {
  const base = new URL(mount), id = '5e155b04-31db-4117-a0ca-1e3e4d8cfd26'
  for (const [from, to] of [
    ['', ''], ['index.html', ''], ['?choose=1', '?choose=1'],
    [`?diagram=${id}`, `diagram/${id}`], [`index.html?diagram=${id}&choose=1#note`, `diagram/${id}?choose=1#note`],
    [`?localFile=${id}`, `file/local/${id}`], [`?fileSession=${id}`, `file/session/${id}`],
    ['?localFile=1', 'file/local/1'], ['tracker/mc-12/?diagram=main&choose=1', 'tracker/MC-12?choose=1'],
    ['activity/', 'activity'],
    [`diagram/${id}/?localFile=1`, `diagram/${id}`],
    [`file/local/${id}/`, `file/local/${id}`], [`file/session/${id}/`, `file/session/${id}`],
  ]) {
    const canonical = canonicalDiagramUrl(new URL(from, base), base)
    expect(canonical.href).toBe(new URL(to, base).href)
    expect(canonicalDiagramUrl(canonical, base).href).toBe(canonical.href)
  }
  for (const path of ['diagram/main', '?diagram=main', 'diagram/bad', 'file/local/main', 'file/session/main', 'file/session/1', 'file/unknown/' + id,
    'file/local/' + id + '/extra', 'diagram/main/extra', 'file/local/%2F', 'tracker/%ZZ']) {
    expect(() => canonicalDiagramUrl(new URL(path, base), base)).toThrow()
  }
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
