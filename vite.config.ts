import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'

export default defineConfig({
  plugins: [react(), {
    name: 'offline-shell',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(name => !name.endsWith('.map'))
      const version = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 12)
      // Кешируется оболочка приложения; документ хранится только в IndexedDB.
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const CACHE = 'decompose-shell-${version}';
const FILES = ${JSON.stringify(['/','/index.html', ...files.filter(name => name !== 'index.html').map(name => `/${name}`)])};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('decompose-shell-') && name !== CACHE).map(name => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then(cache => cache.match('/'))));
  } else if (FILES.includes(new URL(event.request.url).pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request)).then(cached => cached || fetch(event.request)));
  }
});
` })
    },
  }],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/collaboration': {
        target: 'ws://127.0.0.1:3000',
        ws: true,
      },
      '/healthz': 'http://127.0.0.1:3000',
    },
  },
})
