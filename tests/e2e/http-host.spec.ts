import { test, expect } from '@playwright/test'

// Это настоящий insecure origin, а не localhost с подменённым randomUUID.
test.use({ launchOptions: { args: ['--host-resolver-rules=MAP decompose.test 127.0.0.1', '--no-proxy-server'] } })

test('HTTP on a custom hostname supports UUIDs, same-origin API, collaboration and reload', async ({ page, browser }) => {
  const origin = 'http://decompose.test:4173'
  const errors: string[] = []
  const apiUrls: string[] = []
  const socketUrls: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiUrls.push(request.url()) })
  page.on('websocket', socket => socketUrls.push(socket.url()))
  await page.goto(`${origin}/`)
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
  expect(await page.evaluate(() => ({ secure: isSecureContext, randomUUID: typeof crypto.randomUUID,
    getRandomValues: typeof crypto.getRandomValues }))).toEqual({ secure: false, randomUUID: 'undefined', getRandomValues: 'function' })
  const id = await page.evaluate(() => localStorage.getItem('decompose:participant:v1'))
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  await page.getByRole('button', { name: 'Представиться', exact: true }).click()
  await page.getByLabel('Имя', { exact: true }).fill('Участник по HTTP')
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click()
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.getByLabel('Новая схема', { exact: true }).fill('Схема по HTTP')
  await page.getByRole('button', { name: 'Создать', exact: true }).click()
  await expect(page).toHaveURL(/\/diagram\//)
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')

  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  other.on('pageerror', error => errors.push(error.message))
  other.on('websocket', socket => socketUrls.push(socket.url()))
  try {
    await other.goto(page.url())
    await expect(other.locator('main')).toHaveAttribute('data-ready', 'true')
    await page.locator('[data-cell-id="root"]').click()
    await page.keyboard.press('Tab')
    await page.getByRole('textbox', { name: 'Текст клеточки' }).fill('Карточка через WebSocket')
    await page.keyboard.press('Enter')
    await expect(other.locator('[data-text="Карточка через WebSocket"]')).toBeVisible()
    await page.reload()
    await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
    await expect(page.locator('[data-text="Карточка через WebSocket"]')).toBeVisible()
    await expect(page.locator('.identity-trigger span')).toHaveAttribute('data-user-id', id!)
    await expect(page.locator('.identity-trigger span')).toHaveAttribute('title', 'Участник по HTTP (ты)')

    // Вложенный маршрут тоже использует /api и /collaboration от корня сайта.
    await page.goto(`${origin}/tracker/HTTP-4173`)
    await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
    await expect(page.locator('[data-cell-id="root"]')).toHaveAttribute('data-text', 'HTTP-4173')
    // На обычном HTTP доступна выгрузка, но не обещаем запись в исходный файл.
    await page.getByRole('button', { name: 'Схемы', exact: true }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: /^Сохранить в файл…/ }).click()
    await expect(page.getByRole('checkbox', { name: 'Удалить из внутреннего хранилища и продолжить работу с файлом' })).toBeDisabled()
    await page.getByRole('button', { name: 'Скачать копию', exact: true }).click()
    expect((await download).suggestedFilename()).toBe('HTTP-4173.decompose.json')
    await page.getByRole('button', { name: 'Схемы', exact: true }).click()
    await page.getByRole('button', { name: 'Открыть файл…', exact: true }).click()
    await page.getByLabel('Редактировать файл на диске').check()
    await expect(page.getByRole('button', { name: 'Выбрать файл…' })).toBeDisabled()
    await expect(page.getByRole('dialog', { name: 'Открыть файл схемы' })).toContainText('HTTPS')
    await page.getByRole('button', { name: 'Отмена', exact: true }).click()
    expect(apiUrls.length).toBeGreaterThan(0)
    expect(apiUrls.every(url => new URL(url).origin === origin)).toBe(true)
    expect(socketUrls.length).toBeGreaterThanOrEqual(3)
    expect(socketUrls.every(url => url === 'ws://decompose.test:4173/collaboration')).toBe(true)
    expect(errors).toEqual([])
  } finally { await otherContext.close() }
})
