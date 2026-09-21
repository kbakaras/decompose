import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createUuid } from '../shared/uuid'
import { resolve } from 'node:path'
import express, { type ErrorRequestHandler } from 'express'
import * as Y from 'yjs'
import { Server } from '@hocuspocus/server'
import { TrackerStorage } from './tracker-storage'
import { createImportedDocument, initializeDocument, getStructures, readText, ROOT_ID, SCHEMA_VERSION } from '../domain'
import { diagramTitle, normalizeTitle, isDiagramId, type DiagramSummary } from '../shared/diagrams'
import { ImportError, IMPORT_JSON_LIMIT } from '../shared/diagram-import'
import { normalizeTrackerKey } from '../shared/tracker'
import { relativeAppRoot, setHtmlBase } from '../shared/app-base'
import { Replacements } from './replacement'
import { FileRooms } from './file-rooms'
import { DIAGRAM_FILE_LIMIT } from '../shared/diagram-file'

export function createBackend(options: { dataDir: string; clientDir: string }) {
  mkdirSync(options.dataDir, { recursive: true })
  const storage = new TrackerStorage(resolve(options.dataDir, 'decompose.sqlite'))
  const fileRooms = new FileRooms(undefined, { get: id => storage.fileSessionHash(id), set: (id, hash) => storage.registerFileSession(id, hash) })
  let replacements: Replacements
  const transport = new Server({
    quiet: true,
    stopOnSignals: false,
    websocketOptions: { maxPayload: 5 * 1024 * 1024 },
    extensions: [storage],
    debounce: 100,
    maxDebounce: 500,
    async onAuthenticate({ documentName }) {
      if (!storage.accepts(documentName) || replacements.locked(documentName)) {
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
    async beforeSync({ documentName, connection }) {
      connection.readOnly = !storage.accepts(documentName) || !replacements.canWrite(documentName, connection)
    },
    async connected({ documentName, connection }) { replacements.joined(documentName, connection) },
    async onStateless(payload) { replacements.acknowledge(payload) },
    async onDisconnect({ documentName }) { replacements.disconnected(documentName) },
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
  replacements = new Replacements(storage, collaboration)
  const app = express()
  app.disable('x-powered-by')
  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }))
  app.use('/api', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.post('/api/diagrams/import', express.json({ limit: DIAGRAM_FILE_LIMIT }), (request, response) => {
    if (request.body?.format === undefined && Buffer.byteLength(JSON.stringify(request.body)) > IMPORT_JSON_LIMIT) {
      response.status(413).json({ error: 'Превышен допустимый размер запроса.' }); return
    }
    const doc = createImportedDocument(request.body, 'center')
    const id = createUuid()
    try {
      const title = diagramTitle(readText(getStructures(doc).nodes.get(ROOT_ID)!))
      storage.db!.prepare('INSERT INTO documents (name, data) VALUES (?, ?)').run(id, Buffer.from(Y.encodeStateAsUpdate(doc)))
      response.status(201).json({ id, title } satisfies DiagramSummary)
    } finally { doc.destroy() }
  })
  app.post('/api/diagrams/:id/replace', express.json({ limit: DIAGRAM_FILE_LIMIT + 1024 }), async (request, response) => {
    response.json(await replacements.replace(request.params.id, request.body?.generation, request.body?.file))
  })
  const deletedResponse = (id: string, response: express.Response) => {
    const deleted = storage.deleted(id)
    if (!deleted) return false
    response.status(410).json({ error: 'Схема удалена.', code: 'deleted', ...deleted })
    return true
  }
  app.get('/api/diagrams/:id/generation', (request, response) => {
    const id = request.params.id
    if (deletedResponse(id, response)) return
    if (!isDiagramId(id) || !storage.accepts(storage.currentName(id))) { response.status(404).json({ error: 'Схема не найдена' }); return }
    response.json({ generation: storage.generation(id) })
  })
  app.post('/api/file-sessions', express.json({ limit: '10mb' }), (request, response) => {
    try {
      const result = fileRooms.create(request.body?.state, request.body?.id, request.headers.authorization)
      response.status(result.status).json(result.body)
    }
    catch { response.status(400).json({ error: 'Не удалось открыть совместную файловую сессию.' }) }
  })
  app.get('/api/file-sessions/:id/resume', (request, response) => {
    const result = fileRooms.resume(request.params.id, request.headers.authorization)
    response.set('Cache-Control', 'no-store').status(result.status).json(result.body)
  })
  app.get('/api/file-sessions/:id', (request, response) => {
    const result = fileRooms.lookup(request.params.id)
    response.status(result.status).json(result.body)
  })
  app.post('/api/file-sessions/:id/restore', express.json({ limit: '10mb' }), (request, response) => {
    try {
      const result = fileRooms.restore(request.params.id, request.headers.authorization, request.body?.state, request.body?.replace === true)
      response.status(result.status).json(result.body)
    } catch { response.status(400).json({ error: 'Не удалось восстановить файловую сессию.' }) }
  })
  app.use('/api', express.json({ limit: '16kb' }))
  app.delete('/api/diagrams/:id', async (request, response) => {
    response.json(await replacements.remove(request.params.id, request.body?.generation, request.body?.operation))
  })
  app.post('/api/diagrams/:id/file-transfer', async (request, response) => {
    response.json(await replacements.prepareTransfer(request.params.id, request.body?.generation, request.body?.operation))
  })
  app.post('/api/diagrams/:id/file-transfer/:operation/commit', (request, response) => {
    response.json(replacements.commitTransfer(request.params.id, request.params.operation))
  })
  app.delete('/api/diagrams/:id/file-transfer/:operation', (request, response) => {
    replacements.abortTransfer(request.params.id, request.params.operation); response.sendStatus(204)
  })
  const summarize = (row: { name: string; data: Buffer }): DiagramSummary => {
    const live = collaboration.documents.get(storage.currentName(row.name))
    const doc = live ?? new Y.Doc()
    try {
      if (!live) Y.applyUpdate(doc, row.data)
      const root = getStructures(doc).nodes.get(ROOT_ID)
      const tracker = storage.trackerForDocument(row.name)
      return { ...(tracker ?? {}), id: row.name, title: diagramTitle(root ? readText(root) : '', tracker?.trackerKey) }
    } finally {
      if (!live) doc.destroy()
    }
  }
  app.get('/api/diagrams', (_request, response) => {
    const rows = storage.db!.prepare(`SELECT name, data FROM documents
      WHERE NOT EXISTS (SELECT 1 FROM tracker_diagrams WHERE document_id = name) ORDER BY rowid`).all() as { name: string; data: Buffer }[]
    response.json(rows.filter(row => isDiagramId(row.name)).map(summarize))
  })
  app.get('/api/diagrams/:id', (request, response) => {
    const id = request.params.id
    if (deletedResponse(id, response)) return
    const row = isDiagramId(id)
      ? storage.db!.prepare('SELECT name, data FROM documents WHERE name = ?').get(id) as { name: string; data: Buffer } | undefined
      : undefined
    if (!row) { response.status(404).json({ error: 'Схема не найдена' }); return }
    response.json(summarize(row))
  })
  app.post('/api/diagrams', (request, response) => {
    const title = typeof request.body?.title === 'string' ? normalizeTitle(request.body.title) : ''
    if (!title || title.length > 500) {
      response.status(400).json({ error: 'Название должно содержать от 1 до 500 символов' })
      return
    }
    const id = createUuid()
    const doc = new Y.Doc()
    try {
      initializeDocument(doc, 'center')
      getStructures(doc).nodes.get(ROOT_ID)!.set('text', title)
      storage.db!.prepare('INSERT INTO documents (name, data) VALUES (?, ?)').run(id, Buffer.from(Y.encodeStateAsUpdate(doc)))
    } finally { doc.destroy() }
    response.status(201).json({ id, title } satisfies DiagramSummary)
  })
  app.get('/api/tracker', (request, response) => {
    const q = request.query.q ?? ''
    const offset = request.query.offset ?? '0'
    if (typeof q !== 'string' || q.length > 500 || typeof offset !== 'string'
      || !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) {
      response.status(400).json({ error: 'Некорректные параметры поиска' }); return
    }
    response.json(storage.listTracker(q, Number(offset)))
  })
  app.get('/api/tracker/:key', (request, response) => {
    const key = normalizeTrackerKey(request.params.key)
    if (!key) { response.status(400).json({ error: 'Некорректный ключ задачи' }); return }
    const item = storage.findTracker(key)
    if (!item) {
      const deleted = storage.deletedTracker(key)
      if (deleted) { response.status(410).json({ error: 'Дерево задачи удалено.', code: 'deleted', ...deleted }); return }
    }
    if (!item) { response.status(404).json({ error: 'Дерево задачи ещё не создано' }); return }
    response.json(item)
  })
  app.post('/api/tracker/:key', (request, response) => {
    const key = normalizeTrackerKey(request.params.key)
    if (!key) { response.status(400).json({ error: 'Некорректный ключ задачи' }); return }
    const { item, created } = storage.ensureTracker(key, request.body?.recreateDeletedId)
    response.status(created ? 201 : 200).json(item)
  })
  app.use('/api', (_request, response) => { response.status(404).json({ error: 'Неизвестный API-маршрут' }) })
  const apiError: ErrorRequestHandler = (error, _request, response, _next) => {
    const status = [400, 409, 413].includes(error.status) ? error.status : 500
    if (status === 500) console.error(error)
    response.status(status).json({ error: error instanceof ImportError || status === 409 ? error.message
      : status === 413 ? 'Превышен допустимый размер запроса.'
        : status === 500 ? 'Не удалось выполнить запрос' : 'Некорректный запрос' })
  }
  app.use('/api', apiError)
  let shell: Promise<string> | undefined
  app.get(['/', '/index.html', '/tracker/:key', '/diagram/:id', '/file/local/:id', '/file/session/:id'], async (request, response) => {
    shell ??= readFile(resolve(options.clientDir, 'index.html'), 'utf8').catch(error => { shell = undefined; throw error })
    response.type('html').set('Cache-Control', 'no-cache').send(setHtmlBase(await shell, relativeAppRoot(request.path)))
  })
  app.use(express.static(options.clientDir, { maxAge: 0, index: false }))
  const server = transport.httpServer
  server.removeAllListeners('request')
  server.on('request', app)
  const upgrade = server.listeners('upgrade')[0]
  server.removeAllListeners('upgrade')
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname === '/file-collaboration') {
      fileRooms.transport.httpServer.emit('upgrade', request, socket, head)
    } else upgrade.call(server, request, socket, head)
  })

  return {
    collaboration,
    fileRooms,
    async listen(port = 3000, host = '127.0.0.1') {
      // Проверяем SQLite до приёма клиентов; документы создаются только явным действием.
      await storage.onConfigure()
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
      replacements.close()
      await fileRooms.close()
      await transport.destroy()
      storage.db?.close()
    },
  }
}
