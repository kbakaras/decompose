import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import express from 'express'
import { Server } from '@hocuspocus/server'
import { SQLite } from '@hocuspocus/extension-sqlite'
import { initializeDocument, getStructures, SCHEMA_VERSION } from '../domain'

export function createBackend(options: { dataDir: string; clientDir: string }) {
  mkdirSync(options.dataDir, { recursive: true })
  const storage = new SQLite({ database: resolve(options.dataDir, 'decompose.sqlite') })
  const transport = new Server({
    quiet: true,
    stopOnSignals: false,
    websocketOptions: { maxPayload: 5 * 1024 * 1024 },
    extensions: [storage],
    debounce: 100,
    maxDebounce: 500,
    async onAuthenticate({ documentName }) {
      if (documentName !== 'main') throw new Error('Неизвестный документ')
      return {}
    },
    async onUpgrade({ request, socket }) {
      if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/collaboration') {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
        // Hocuspocus использует пустое отклонение для остановки обработанной upgrade-заявки.
        return Promise.reject()
      }
    },
    async afterLoadDocument({ document }) {
      const version = getStructures(document).meta.get('schemaVersion')
      if (version !== undefined && version !== 1 && version !== SCHEMA_VERSION) {
        throw new Error('Неподдерживаемая версия документа')
      }
      initializeDocument(document)
    },
  })
  const collaboration = transport.hocuspocus
  const app = express()
  app.disable('x-powered-by')
  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }))
  app.use(express.static(options.clientDir, { maxAge: 0 }))
  app.get('/', (_request, response) => response.sendFile(resolve(options.clientDir, 'index.html')))
  const server = transport.httpServer
  server.removeAllListeners('request')
  server.on('request', app)

  return {
    collaboration,
    async listen(port = 3000, host = '127.0.0.1') {
      // Проверяем SQLite до приёма клиентов и создаём root единственным серверным writer.
      const initial = await collaboration.openDirectConnection('main')
      await initial.disconnect()
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolveListen()
        })
      })
      return (server.address() as AddressInfo).port
    },
    async close() {
      await transport.destroy()
      storage.db?.close()
    },
  }
}
