import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dataDir = mkdtempSync(join(tmpdir(), 'decompose-e2e-'))
process.env.DATA_DIR = dataDir
process.env.HOST = '127.0.0.1'
process.env.PORT = '4173'
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }))
// Браузер проверяет собранные backend и frontend, включая production service worker.
await import(pathToFileURL(resolve('dist/server/index.js')).href)
