import { test, expect, type Page } from '@playwright/test'
import { testDiagram } from './fixtures'

const start = (page: Page) => page.getByRole('button', { name: 'Начать работу' })
const picker = (page: Page) => page.getByRole('dialog', { name: 'Выбор схемы для редактирования' })
const ready = (page: Page) => expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
const root = (page: Page) => page.locator('[data-cell-id="root"]')

test('home is a guest landing page without a document or collaboration connection', async ({ page }) => {
  const before = await (await page.request.get('/api/diagrams')).json()
  const sockets: string[] = [], requests: string[] = []
  page.on('websocket', socket => sockets.push(socket.url()))
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()) })
  await page.goto('/')
  await expect(start(page)).toBeVisible()
  await expect(page.locator('.home-version')).toHaveText('Версия local')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Большую задачу —по веточкам')
  await expect(page.locator('[data-cell-id], .connection, .avatars')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(sockets).toEqual([]); expect(requests).toEqual([])
  await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true })
  await start(page).click()
  await expect(picker(page)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Текущая схема' })).toHaveCount(0)
  await expect(picker(page).getByRole('tab')).toHaveText(['Схемы', 'Задачи', 'Файлы'])
  await page.screenshot({ path: 'test-results/home-picker.png' })
  await page.keyboard.press('Escape'); await expect(start(page)).toBeFocused()
  await page.keyboard.press('Control+o'); await expect(picker(page)).toBeVisible()
  await page.keyboard.press('Escape')
  for (const width of [640, 375]) {
    await page.setViewportSize({ width, height: 720 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    await expect(start(page)).toBeInViewport()
    const version = await page.locator('.home-version').boundingBox()
    const content = await page.locator('.home-content').boundingBox()
    const features = await page.locator('.home-features').boundingBox()
    expect(version).not.toBeNull()
    expect(content).not.toBeNull()
    expect(features).not.toBeNull()
    expect(version!.x + version!.width).toBeLessThanOrEqual(content!.x + content!.width)
    expect(version!.y).toBeGreaterThanOrEqual(features!.y + features!.height)
    expect(await page.locator('.home-version').evaluate(element => getComputedStyle(element).position)).toBe('absolute')
    await page.screenshot({ path: `test-results/home-${width}.png` })
  }
  await page.locator('.home-version').scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/home-version-mobile.png' })
  expect(await (await page.request.get('/api/diagrams')).json()).toEqual(before)
})

test('home picker requires identity only for creation and never creates a hidden main', async ({ page }) => {
  const before = await (await page.request.get('/api/diagrams')).json()
  await page.goto('/?choose=1')
  await expect(picker(page)).toBeVisible()
  await expect(page).toHaveURL('http://127.0.0.1:4173/')
  await page.getByLabel('Поиск или название новой схемы', { exact: true }).fill('Из главной страницы')
  await page.getByRole('button', { name: 'Создать', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Представься' })).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await (await page.request.get('/api/diagrams')).json()).toEqual(before)
  await page.getByRole('button', { name: 'Создать', exact: true }).click()
  await page.getByRole('textbox', { name: 'Имя' }).fill('Автор')
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click()
  await ready(page)
  await expect(page).toHaveURL(/\/diagram\/[0-9a-f-]{36}$/)
  await expect(root(page)).toHaveAttribute('data-text', 'Из главной страницы')
  expect((await (await page.request.get('/api/diagrams')).json()).length).toBe(before.length + 1)
})

test('returning home flushes drafts, leaves presence, and supports back and forward', async ({ page, context }) => {
  await context.addInitScript(() => localStorage.setItem('decompose:participant-name:v1', 'Автор'))
  const url = await testDiagram(page), peer = await context.newPage()
  await page.goto('/'); await expect(start(page)).toBeVisible()
  await start(page).click()
  await page.locator(`.diagrams-list a[href="diagram/${url.split('/').pop()}"]`).click()
  await ready(page); await peer.goto(url); await ready(peer)
  await expect(peer.locator('.cell-with-presence')).toHaveCount(1)
  await root(page).dblclick(); await page.getByRole('textbox', { name: 'Текст клеточки' }).fill('Draft перед главной')
  await page.getByRole('link', { name: 'дерево·дел', exact: true }).click()
  await expect(start(page)).toBeVisible()
  await expect(root(peer)).toHaveAttribute('data-text', 'Draft перед главной')
  await expect(peer.locator('.cell-with-presence')).toHaveCount(0)
  await page.goBack(); await ready(page)
  await expect(root(page)).toHaveAttribute('data-text', 'Draft перед главной')
  await page.goForward(); await expect(start(page)).toBeVisible()
  await peer.close()
})

test('home imports a file directly without an intermediate empty diagram', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('decompose:participant-name:v1', 'Автор'))
  const before = await (await page.request.get('/api/diagrams')).json()
  await page.goto('/'); await start(page).click()
  await picker(page).getByRole('tab', { name: 'Файлы' }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Новая схема из файла' }).click()
  await (await chooser).setFiles('tests/fixtures/yed-tree.graphml')
  await ready(page)
  await expect(root(page)).toHaveAttribute('data-text', 'Учебная схема')
  expect((await (await page.request.get('/api/diagrams')).json()).length).toBe(before.length + 1)
})

test('home task creation can be cancelled and retried without an ordinary diagram', async ({ page }) => {
  const before = await (await page.request.get('/api/diagrams')).json()
  await page.goto('/')
  for (const accept of [false, true]) {
    await start(page).click()
    await picker(page).getByRole('tab', { name: 'Задачи' }).click()
    await page.getByLabel('Поиск задач', { exact: true }).fill('HOME-101')
    await page.getByRole('button', { name: 'Создать', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Представься' })).toBeVisible()
    if (!accept) {
      await page.keyboard.press('Escape')
      await expect(start(page)).toBeEnabled()
      expect((await page.request.get('/api/tracker/HOME-101')).status()).toBe(404)
    } else {
      await page.getByLabel('Имя', { exact: true }).fill('Автор задачи')
      await page.getByRole('button', { name: 'Продолжить', exact: true }).click()
      await ready(page)
      await expect(root(page)).toHaveAttribute('data-text', 'HOME-101')
      await expect(page).toHaveURL(/\/tracker\/HOME-101$/)
    }
  }
  expect(await (await page.request.get('/api/diagrams')).json()).toEqual(before)
})

test('offline home opens a cached diagram through its catalog', async ({ page, context }) => {
  const url = await testDiagram(page)
  await page.goto(url); await ready(page)
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await page.getByRole('link', { name: 'дерево·дел', exact: true }).click()
  await expect(start(page)).toBeVisible()
  await context.setOffline(true)
  await page.reload(); await expect(start(page)).toBeVisible()
  await start(page).click()
  await expect(picker(page).getByRole('button', { name: 'Создать', exact: true })).toBeDisabled()
  await page.locator(`.diagrams-list a[href="diagram/${url.split('/').pop()}"]`).click()
  await ready(page)
  await expect(root(page)).toHaveAttribute('data-text', 'Тестовая схема')
})

test('home clears only retired main caches and pending drafts, preserving identity and other documents', async ({ page }) => {
  await page.goto('/healthz')
  await page.evaluate(async () => {
    localStorage.setItem('decompose:participant-name:v1', 'Сохранить имя')
    localStorage.setItem('decompose:generation:main', '2')
    localStorage.setItem('decompose:diagrams:v1', JSON.stringify([{ id: 'main', title: 'Старая' }, { id: 'other', title: 'Оставить' }]))
    sessionStorage.setItem('decompose:pending:main~2', 'старый draft')
    sessionStorage.setItem('decompose:pending:other', 'сохранить draft')
    for (const name of ['decompose:main:v1', 'decompose:main~2:v1', 'decompose:other:v1']) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => { request.result.close(); resolve() }; request.onerror = () => reject(request.error)
      })
    }
  })
  await page.goto('/'); await expect(start(page)).toBeVisible()
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map(db => db.name).filter(name => name?.startsWith('decompose:main')))).toEqual([])
  expect(await page.evaluate(() => ({
    name: localStorage.getItem('decompose:participant-name:v1'), generation: localStorage.getItem('decompose:generation:main'),
    catalog: JSON.parse(localStorage.getItem('decompose:diagrams:v1')!), pending: sessionStorage.getItem('decompose:pending:main~2'),
    other: sessionStorage.getItem('decompose:pending:other'),
  }))).toEqual({ name: 'Сохранить имя', generation: null, catalog: [{ id: 'other', title: 'Оставить' }], pending: null, other: 'сохранить draft' })
  expect(await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name))).toContain('decompose:other:v1')
})
