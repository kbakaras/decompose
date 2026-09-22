import { test, expect, testDiagram, type Page } from './fixtures'

const readyDiagram = async (page: Page) => {
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
}

test('activity page shows every live tab, anonymous users and a working diagram link', async ({ page, context, browser }) => {
  const diagramUrl = await testDiagram(page)
  const second = await context.newPage()
  const anonymousContext = await browser.newContext()
  const anonymous = await anonymousContext.newPage()
  const activity = await context.newPage()
  try {
    await Promise.all([page.goto(diagramUrl), second.goto(diagramUrl), anonymous.goto(diagramUrl)])
    await Promise.all([readyDiagram(page), readyDiagram(second), readyDiagram(anonymous)])
    await activity.goto('/activity')
    await expect(activity.locator('main')).toHaveAttribute('data-ready', 'true')
    await expect(activity).toHaveURL(/\/activity$/)
    await expect(activity.locator('[data-activity-kind="root"]')).toHaveText('Активные подключения')
    await expect(activity.locator('[data-activity-kind="mode"]')).toContainText(['Схемы', 'Мониторинг'])
    await expect(activity.locator('[data-activity-kind="resource"]')).toHaveText('Тестовая схема')
    await expect(activity.locator('[data-activity-kind="participant"]', { hasText: 'Участник теста' })).toHaveCount(3)
    await expect(activity.locator('[data-activity-kind="participant"]', { hasText: 'Анонимный пользователь' })).toHaveCount(1)
    await expect(activity.locator('[data-activity-kind="participant"]').first())
      .toHaveCSS('background-color', 'rgb(255, 245, 217)')

    await anonymous.close()
    await expect(activity.locator('[data-activity-kind="participant"]', { hasText: 'Анонимный пользователь' })).toHaveCount(0)

    const link = activity.getByRole('link', { name: 'Открыть схему «Тестовая схема»' })
    expect(await link.getAttribute('href')).toBe(diagramUrl)
    await link.click()
    await readyDiagram(activity)
    await expect(activity).toHaveURL(diagramUrl)
  } finally {
    await anonymousContext.close()
  }
})

test('activity page works from a stripped reverse-proxy prefix', async ({ page }) => {
  const sockets: string[] = []
  page.on('websocket', socket => sockets.push(socket.url()))
  const base = 'http://127.0.0.1:4183/decompose/'
  await page.goto(base + 'activity/')
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
  await expect(page).toHaveURL(base + 'activity')
  expect(await page.evaluate(() => document.baseURI)).toBe(base)
  expect(sockets).toContain('ws://127.0.0.1:4183/decompose/activity-collaboration')
  await expect(page.locator('[data-activity-kind="mode"]')).toContainText(['Мониторинг'])
})
