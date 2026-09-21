import { createTestDiagram } from './helpers'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createBackend } from '../../src/server/app'

function status(port: number, path: string, headers: Record<string, string>, upgrade = false): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: {
      ...headers,
      ...(upgrade ? { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } : {}),
    } }, response => {
      response.resume()
      response.on('end', () => resolveStatus(response.statusCode!))
      response.on('error', reject)
    })
    req.on('upgrade', (response, socket) => { socket.destroy(); resolveStatus(response.statusCode!) })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('Тайм-аут проверки reverse proxy')))
    req.end()
  })
}

it('serves HTTP and WebSocket behind arbitrary external hosts without relaxing route checks', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-proxy-'))
  const backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  try {
    const port = await backend.listen(0)
    const id = await createTestDiagram(`http://127.0.0.1:${port}`)
    for (const origin of ['http://decompose.luxburg', 'http://lan.example:8080', 'https://another-host.example:8443']) {
      const url = new URL(origin)
      const headers = { Host: url.host, Origin: origin, 'X-Forwarded-Host': url.host,
        'X-Forwarded-Proto': url.protocol.slice(0, -1), 'X-Forwarded-For': '192.0.2.10' }
      expect(await status(port, '/api/diagrams', headers)).toBe(200)
      expect(await status(port, `/api/diagrams/${id}`, headers)).toBe(200)
      expect(await status(port, '/api/diagrams/unknown', headers)).toBe(404)
      expect(await status(port, '/collaboration', headers, true)).toBe(101)
      expect(await status(port, '/not-collaboration', headers, true)).toBe(404)
    }
  } finally { await backend.close(); await rm(dataDir, { recursive: true, force: true }) }
}, 20000)
