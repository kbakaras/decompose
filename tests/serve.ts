import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { startPrefixProxy } from './prefix-proxy'

const dataDir = mkdtempSync(join(tmpdir(), 'decompose-e2e-'))
process.env.DATA_DIR = dataDir
process.env.HOST = '127.0.0.1'
process.env.PORT = '4173'
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }))
// Браузер проверяет собранные backend и frontend, включая production service worker.
await import(pathToFileURL(resolve('dist/server/index.js')).href)

// Небольшая fixture проверяет реальные dynamic imports, не меняя production-сборку.
const fixtureDir = join(dataDir, 'chunks')
await build({ configFile: resolve('vite.config.ts'), root: resolve('tests/fixtures/relative-build'),
  publicDir: resolve('public'), logLevel: 'error', build: { outDir: fixtureDir, emptyOutDir: true } })
const closeProxy = await startPrefixProxy(4173, 4183, fixtureDir)
process.on('SIGINT', closeProxy)
process.on('SIGTERM', closeProxy)
