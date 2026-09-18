import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { relativeAppRoot, setHtmlBase } from '../src/shared/app-base'

/** Тестовый аналог handle_path: обе публикации ведут в один backend. */
export async function startPrefixProxy(upstreamPort: number, port: number, fixtureDir: string) {
  const sockets = new Set<Duplex>()
  const prefixes = ['/decompose', '/tools/tree']
  const route = (req: IncomingMessage): { path: string; redirect?: string } | null => {
    const url = new URL(req.url ?? '/', 'http://test.invalid')
    for (const prefix of prefixes) {
      if (url.pathname === prefix) return { path: '/', redirect: `${prefix}/${url.search}` }
      if (url.pathname.startsWith(prefix + '/')) return { path: url.pathname.slice(prefix.length) + url.search }
    }
    // На этом hostname приложение опубликовано только под префиксом.
    return req.headers.host?.startsWith('gateway.test:') ? null : { path: req.url ?? '/' }
  }
  const options = (req: IncomingMessage, path: string) => ({
    hostname: '127.0.0.1', port: upstreamPort, path, method: req.method,
    headers: { ...req.headers, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'http' },
  })
  const fixture = async (path: string, res: ServerResponse) => {
    const pathname = new URL(path, 'http://test.invalid').pathname.slice('/__chunks'.length)
    if (pathname === '/' || pathname === '/index.html' || /^\/tracker\/[^/]+\/?$/.test(pathname)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(setHtmlBase(await readFile(resolve(fixtureDir, 'index.html'), 'utf8'), relativeAppRoot(pathname)))
      return
    }
    const file = resolve(fixtureDir, '.' + decodeURIComponent(pathname))
    if (!file.startsWith(fixtureDir + sep)) { res.writeHead(404).end(); return }
    const bytes = await readFile(file)
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript')
    res.end(bytes)
  }
  const server = createServer((req, res) => {
    const matched = route(req)
    if (!matched) { res.writeHead(404).end(); return }
    if (matched.redirect) { res.writeHead(308, { Location: matched.redirect }).end(); return }
    if (matched.path.startsWith('/__chunks/')) {
      void fixture(matched.path, res).catch(() => { if (!res.headersSent) res.writeHead(404); res.end() })
      return
    }
    const upstream = request(options(req, matched.path), response => {
      res.writeHead(response.statusCode!, response.headers)
      response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    const matched = route(req)
    if (!matched || matched.redirect) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return }
    const upstream = request(options(req, matched.path))
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      sockets.add(peer)
      peer.on('close', () => { sockets.delete(peer); socket.destroy() })
      socket.on('close', () => peer.destroy())
      peer.on('error', () => socket.destroy())
      socket.on('error', () => peer.destroy())
      const headers = response.rawHeaders.flatMap((value, i, all) => i % 2 === 0 ? [`${value}: ${all[i + 1]}`] : [])
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) peer.write(head)
      socket.pipe(peer).pipe(socket)
    })
    upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\n\r\n`) })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done) })
  return () => { for (const socket of sockets) socket.destroy(); server.close() }
}
