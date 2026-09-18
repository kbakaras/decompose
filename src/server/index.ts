import { resolve } from 'node:path'
import { createBackend } from './app'

const port = Number(process.env.PORT ?? 3000)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный PORT')
const host = process.env.HOST ?? '127.0.0.1'
const backend = createBackend({
  dataDir: resolve(process.env.DATA_DIR ?? 'data'),
  clientDir: resolve('dist/client'),
})
await backend.listen(port, host)
console.log(`Decompose: http://${host}:${port}`)
let closing = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (closing) return
    closing = true
    try { await backend.close(); process.exit(0) }
    catch (error) { console.error(error); process.exit(1) }
  })
}
