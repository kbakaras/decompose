import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import express, { type ErrorRequestHandler } from 'express'
import * as Y from 'yjs'
import { Server } from '@hocuspocus/server'
import { SQLite } from '@hocuspocus/extension-sqlite'
import { createImportedDocument, initializeDocument, getStructures, normalizeText, readText, ROOT_ID, SCHEMA_VERSION } from '../domain'
import { isDiagramId, type DiagramSummary } from '../shared/diagrams'
import { ImportError, IMPORT_JSON_LIMIT } from '../shared/diagram-import'

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
      if (!isDiagramId(documentName) || !storage.db?.prepare('SELECT 1 FROM documents WHERE name = ?').get(documentName)) {
        throw new Error('Неизвестный документ')
      }
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
    async onAwarenessUpdate({ document, connection, updated }) {
      if (!connection) return
      // Yjs помечает возвращение известного client ID как updated, а Hocuspocus 4
      // привязывает к соединению только added. Без этого close оставляет ghost presence.
      const clients = document.getClients(connection)
      for (const clientId of updated) clients.add(clientId)
    },
  })
  const collaboration = transport.hocuspocus
  const app = express()
  app.disable('x-powered-by')
  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }))
  app.use('/api', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.post('/api/diagrams/import', express.json({ limit: IMPORT_JSON_LIMIT }), (request, response) => {
    const doc = createImportedDocument(request.body)
    const id = randomUUID()
    try {
      const title = readText(getStructures(doc).nodes.get(ROOT_ID)!) || 'Новая декомпозиция'
      storage.db!.prepare('INSERT INTO documents (name, data) VALUES (?, ?)').run(id, Buffer.from(Y.encodeStateAsUpdate(doc)))
      response.status(201).json({ id, title } satisfies DiagramSummary)
    } finally { doc.destroy() }
  })
  app.use('/api', express.json({ limit: '16kb' }))
  const summarize = (row: { name: string; data: Buffer }): DiagramSummary => {
    const live = collaboration.documents.get(row.name)
    const doc = live ?? new Y.Doc()
    try {
      if (!live) Y.applyUpdate(doc, row.data)
      const root = getStructures(doc).nodes.get(ROOT_ID)
      return { id: row.name, title: (root && readText(root)) || 'Новая декомпозиция' }
    } finally {
      if (!live) doc.destroy()
    }
  }
  app.get('/api/diagrams', (_request, response) => {
    const rows = storage.db!.prepare('SELECT name, data FROM documents ORDER BY rowid').all() as { name: string; data: Buffer }[]
    response.json(rows.filter(row => isDiagramId(row.name)).map(summarize))
  })
  app.get('/api/diagrams/:id', (request, response) => {
    const id = request.params.id
    const row = isDiagramId(id)
      ? storage.db!.prepare('SELECT name, data FROM documents WHERE name = ?').get(id) as { name: string; data: Buffer } | undefined
      : undefined
    if (!row) { response.status(404).json({ error: 'Схема не найдена' }); return }
    response.json(summarize(row))
  })
  app.post('/api/diagrams', (request, response) => {
    const title = typeof request.body?.title === 'string' ? normalizeText(request.body.title).trim() : ''
    if (!title || title.length > 500) {
      response.status(400).json({ error: 'Название должно содержать от 1 до 500 символов' })
      return
    }
    const id = randomUUID()
    const doc = new Y.Doc()
    try {
      initializeDocument(doc)
      getStructures(doc).nodes.get(ROOT_ID)!.set('text', title)
      storage.db!.prepare('INSERT INTO documents (name, data) VALUES (?, ?)').run(id, Buffer.from(Y.encodeStateAsUpdate(doc)))
    } finally { doc.destroy() }
    response.status(201).json({ id, title } satisfies DiagramSummary)
  })
  app.use('/api', (_request, response) => { response.status(404).json({ error: 'Неизвестный API-маршрут' }) })
  const apiError: ErrorRequestHandler = (error, _request, response, _next) => {
    const status = error.status === 400 || error.status === 413 ? error.status : 500
    if (status === 500) console.error(error)
    response.status(status).json({ error: error instanceof ImportError ? error.message
      : status === 413 ? 'Превышен допустимый размер запроса.'
        : status === 500 ? 'Не удалось выполнить запрос' : 'Некорректный запрос' })
  }
  app.use('/api', apiError)
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
