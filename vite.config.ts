import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relativeAppRoot, setHtmlBase } from './src/shared/app-base'

const brandingFiles = ['brand/logo.png', 'favicon.ico', 'favicon-32.png', 'apple-touch-icon.png']

function serviceWorkerSource(files: string[], version: string) {
  return `
const ROOT = new URL(self.registration.scope);
const PREFIX = 'decompose-shell:' + encodeURIComponent(ROOT.pathname) + ':';
const CACHE = PREFIX + ${JSON.stringify(version)};
const FILES = ${JSON.stringify(files)}.map(path => new URL(path, ROOT).href);
const relativeAppRoot = ${relativeAppRoot.toString()};
const setHtmlBase = ${setHtmlBase.toString()};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name =>
    (name.startsWith(PREFIX) && name !== CACHE) ||
    (ROOT.pathname === '/' && /^decompose-shell-[a-f0-9]{12}$/.test(name))
  ).map(name => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;
  const path = url.pathname.slice(ROOT.pathname.length);
  if (path === 'api' || path.startsWith('api/') || path === 'collaboration') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => {
      const cached = await (await caches.open(CACHE)).match(ROOT.href);
      if (!cached) throw new Error('Оболочка приложения не сохранена');
      const html = setHtmlBase(await cached.text(), relativeAppRoot('/' + path));
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }));
  } else if (FILES.includes(url.href)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request)).then(cached => cached || fetch(event.request)));
  }
});
`
}

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'relative-app-base',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!context.server) return html
        return setHtmlBase(html, relativeAppRoot((context.originalUrl ?? context.path).split('?')[0]))
      },
    },
  }, {
    name: 'offline-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(name => !name.endsWith('.map'))
      const cachedFiles = ['./', ...brandingFiles, ...files]
      const hash = createHash('sha256').update(serviceWorkerSource(cachedFiles, ''))
      const html = bundle['index.html']
      if (html?.type === 'asset') hash.update(html.source)
      for (const file of brandingFiles) hash.update(readFileSync(new URL(`./public/${file}`, import.meta.url)))
      const version = hash.digest('hex').slice(0, 12)
      // Кешируется оболочка приложения; документ хранится только в IndexedDB.
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(cachedFiles, version) })
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
      '/activity-collaboration': { target: 'ws://127.0.0.1:3000', ws: true },
      '/file-collaboration': { target: 'ws://127.0.0.1:3000', ws: true },
      '/healthz': 'http://127.0.0.1:3000',
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
