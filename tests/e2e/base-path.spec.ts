import { resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

test.use({ launchOptions: { args: ['--host-resolver-rules=MAP decompose.test 127.0.0.1, MAP gateway.test 127.0.0.1', '--no-proxy-server'] } })
const rootBase = 'http://decompose.test:4183/'
const prefixBase = 'http://gateway.test:4183/decompose/'
const ready = async (page: Page) => { await expect(page.locator('main')).toHaveAttribute('data-ready', 'true') }
const root = (page: Page) => page.locator('[data-cell-id="root"]')
async function ordinaryPicker(page: Page) {
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.getByRole('tablist', { name: 'Раздел каталога' }).getByRole('tab', { name: 'Схемы', exact: true }).click()
}
async function child(page: Page, text: string) {
  await root(page).click()
  await page.keyboard.press('Tab')
  await page.getByRole('textbox', { name: 'Текст клеточки' }).fill(text)
  await page.keyboard.press('Enter')
}

test('one build and backend work simultaneously at root and stripped prefix on insecure HTTP', async ({ page, browser }) => {
  const requests: string[] = []
  const sockets: string[] = []
  const errors: string[] = []
  page.on('request', request => requests.push(request.url()))
  page.on('websocket', socket => sockets.push(socket.url()))
  page.on('pageerror', error => errors.push(error.message))
  // Прямой вход с завершающим слешем требует ../../ до корня приложения.
  await page.goto(prefixBase + 'tracker/multi-4183/')
  await page.getByLabel('Имя', { exact: true }).fill('Через префикс')
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click()
  await ready(page)
  await expect(page).toHaveURL(prefixBase + 'tracker/MULTI-4183')
  expect(await page.evaluate(() => ({ base: document.baseURI, secure: isSecureContext, uuid: typeof crypto.randomUUID })))
    .toEqual({ base: prefixBase, secure: false, uuid: 'undefined' })
  const context = await browser.newContext()
  const peer = await context.newPage()
  peer.on('pageerror', error => errors.push(error.message))
  try {
    await peer.goto(rootBase + 'tracker/MULTI-4183')
    await ready(peer)
    expect(await peer.evaluate(() => document.baseURI)).toBe(rootBase)
    expect(await peer.locator('main').getAttribute('data-diagram-id')).toBe(await page.locator('main').getAttribute('data-diagram-id'))
    expect(await peer.locator('script[type="module"][src]').getAttribute('src')).toBe(await page.locator('script[type="module"][src]').getAttribute('src'))
    await child(page, 'Один backend, два адреса')
    await expect(peer.locator('[data-text="Один backend, два адреса"]')).toBeVisible()
    await page.reload()
    await ready(page)
    await expect(page.locator('[data-text="Один backend, два адреса"]')).toBeVisible()

    await ordinaryPicker(page)
    await page.getByLabel('Поиск или название новой схемы', { exact: true }).fill('Схема с префиксом')
    await page.getByRole('button', { name: 'Создать', exact: true }).click()
    await expect(root(page)).toHaveAttribute('data-text', 'Схема с префиксом')
    const diagramUrl = page.url()
    expect(diagramUrl.startsWith(prefixBase + 'diagram/')).toBe(true)
    await page.goBack()
    await expect(page).toHaveURL(prefixBase + 'tracker/MULTI-4183')
    await ready(page)
    await page.goForward()
    await expect(page).toHaveURL(diagramUrl)
    await ready(page)
    expect(await page.evaluate(() => document.baseURI)).toBe(prefixBase)

    await ordinaryPicker(page)
    await page.getByRole('tablist', { name: 'Раздел каталога' }).getByRole('tab', { name: 'Файлы', exact: true }).click()
    await page.getByRole('button', { name: 'Новая схема из файла', exact: true }).click()
    await page.getByLabel('Файл схемы', { exact: true }).setInputFiles(resolve('tests/fixtures/yed-tree.graphml'))
    await expect(root(page)).toHaveAttribute('data-text', 'Учебная схема')
    expect(page.url().startsWith(prefixBase + 'diagram/')).toBe(true)
    await expect(page.locator('[data-cell-id]')).toHaveCount(28)
    await page.locator('a.brand').click()
    await expect(page).toHaveURL(prefixBase)
    await expect(page.getByRole('button', { name: 'Начать работу' })).toBeVisible()
    expect(await page.locator('.brand img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    expect(await page.evaluate(async () => (await fetch(new URL('favicon.ico', document.baseURI))).status)).toBe(200)
    expect(requests.every(url => url.startsWith(prefixBase))).toBe(true)
    expect(requests.some(url => url.startsWith(prefixBase + 'assets/') && url.endsWith('.css'))).toBe(true)
    expect(requests.some(url => url.startsWith(prefixBase + 'api/diagrams/import'))).toBe(true)
    expect(sockets.length).toBeGreaterThan(2)
    expect(sockets.every(url => url === 'ws://gateway.test:4183/decompose/collaboration')).toBe(true)
    expect(errors).toEqual([])
  } finally { await context.close() }
})

test('redirect preserves query, another nested mount works and error recovery retains the prefix', async ({ page, request }) => {
  const base = 'http://127.0.0.1:4183/tools/tree/'
  const response = await request.get('http://127.0.0.1:4183/tools/tree?diagram=main', { maxRedirects: 0 })
  expect(response.status()).toBe(308)
  expect(response.headers().location).toBe('/tools/tree/?diagram=main')
  await page.goto(base + 'index.html')
  await expect(page.getByRole('button', { name: 'Начать работу' })).toBeVisible()
  await expect(page).toHaveURL(base)
  expect(await page.evaluate(() => document.baseURI)).toBe(base)
  await page.goto(base + '?diagram=invalid')
  await expect(page.getByRole('alert')).toContainText('ссылка некорректна')
  await page.getByRole('link', { name: 'На главную' }).click()
  await expect(page).toHaveURL(base)
  await expect(page.getByRole('button', { name: 'Начать работу' })).toBeVisible()
})

test('prefixed offline deep links retain base and workers do not delete other scopes caches', async ({ page, context }) => {
  const origin = 'http://127.0.0.1:4183/'
  const base = origin + 'decompose/'
  await page.goto(origin + 'healthz')
  await page.evaluate(async () => {
    localStorage.setItem('decompose:participant-name:v1', 'Offline участник')
    await Promise.all(['other-app', 'decompose-shell:%2Fother%2F:keep', 'decompose-shell:%2Fdecompose%2F:old'].map(name => caches.open(name)))
  })
  await page.goto(base + 'tracker/OFFBASE-802')
  await ready(page)
  await child(page, 'Offline под префиксом')
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe(base)
  const id = await page.locator('main').getAttribute('data-diagram-id')
  const keys = await page.evaluate(() => caches.keys())
  expect(keys).toContain('other-app')
  expect(keys).toContain('decompose-shell:%2Fother%2F:keep')
  expect(keys).not.toContain('decompose-shell:%2Fdecompose%2F:old')
  const rootPage = await context.newPage()
  await rootPage.goto(origin)
  await expect(rootPage.getByRole('button', { name: 'Начать работу' })).toBeVisible()
  expect(await rootPage.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe(origin)
  expect((await page.evaluate(() => caches.keys())).some(key => key.startsWith('decompose-shell:%2Fdecompose%2F:'))).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await ready(page)
  expect(await page.evaluate(() => document.baseURI)).toBe(base)
  await expect(page.locator('[data-text="Offline под префиксом"]')).toBeVisible()
  await page.goto(base + 'tracker/OFFBASE-802/')
  await ready(page)
  expect(await page.evaluate(() => document.baseURI)).toBe(base)
  await page.goto(base + `index.html?diagram=${id}`)
  await ready(page)
  await expect(page).toHaveURL(base + `diagram/${id}`)
  await page.reload(); await ready(page)
  expect(await page.evaluate(() => document.baseURI)).toBe(base)
  await expect(page.locator('[data-text="Offline под префиксом"]')).toBeVisible()
  await rootPage.reload()
  await expect(rootPage.getByRole('button', { name: 'Начать работу' })).toBeVisible()
})

test('canonical diagram paths accept old links without adding a history entry at either mount', async ({ page }) => {
  for (const base of [rootBase, prefixBase]) {
    const { id } = await (await page.request.post('/api/diagrams', { data: { title: 'Адрес через path' } })).json()
    await page.goto(base); await expect(page.getByRole('button', { name: 'Начать работу' })).toBeVisible()
    await page.goto(base + `?diagram=${id}&choose=1`)
    await ready(page)
    await expect(page.getByRole('dialog', { name: 'Выбор схемы для редактирования', exact: true })).toBeVisible()
    await expect(page).toHaveURL(base + `diagram/${id}`)
    await page.keyboard.press('Escape')
    await page.goBack(); await expect(page.getByRole('button', { name: 'Начать работу' })).toBeVisible()
    await expect(page).toHaveURL(base)
    await page.goForward(); await ready(page)
    await expect(page).toHaveURL(base + `diagram/${id}`)
    await page.goto(base + `diagram/${id}/`); await ready(page)
    await expect(page).toHaveURL(base + `diagram/${id}`)
    expect(await page.evaluate(() => document.baseURI)).toBe(base)
    await page.reload(); await ready(page)
    await expect(root(page)).toHaveAttribute('data-text', 'Адрес через path')
    await page.goto(base + 'diagram/invalid')
    await expect(page.getByRole('alert')).toContainText('ссылка некорректна')
    await page.getByRole('link', { name: 'На главную' }).click()
    await expect(page.getByRole('button', { name: 'Начать работу' })).toBeVisible(); await expect(page).toHaveURL(base)
  }
})

test('relative Vite dynamic JS and CSS chunks load from both mounts after history changes', async ({ page }) => {
  for (const base of [rootBase, prefixBase]) {
    const requests: string[] = []
    const record = (request: { url(): string }) => requests.push(request.url())
    page.on('request', record)
    await page.goto(base + '__chunks/tracker/CHUNK-1/')
    expect(await page.evaluate(() => document.baseURI)).toBe(base + '__chunks/')
    await page.evaluate(() => history.pushState(null, '', new URL('./?changed=1', document.baseURI)))
    await page.getByRole('button', { name: 'Загрузить модуль' }).click()
    await expect(page.locator('#result')).toHaveText('Динамический модуль загружен')
    await expect(page.locator('#result')).toHaveCSS('color', 'rgb(12, 34, 56)')
    expect(requests.every(url => url.startsWith(base + '__chunks/'))).toBe(true)
    expect(requests.some(url => /\/assets\/lazy-.*\.js$/.test(url))).toBe(true)
    expect(requests.some(url => /\/assets\/lazy-.*\.css$/.test(url))).toBe(true)
    page.off('request', record)
  }
})
