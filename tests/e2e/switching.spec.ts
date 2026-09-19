import { expect, test, namedContext, type Page } from './fixtures'

async function create(page: Page, title: string) {
  const response = await page.request.post('/api/diagrams', { data: { title } })
  expect(response.status()).toBe(201)
  return (await response.json()).id as string
}
async function ready(page: Page, id: string) {
  await expect(page.locator('main')).toHaveAttribute('data-diagram-id', id)
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
}
async function select(page: Page, id: string) {
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.locator(`.diagrams-list a[href="diagram/${id}"]`).click()
}
const root = (page: Page) => page.locator('[data-cell-id="root"]')

test('loading notice is delayed and does not flash on fast or failed navigation', async ({ page }) => {
  const a = await create(page, 'Быстрая схема')
  const b = await create(page, 'Задержанная схема')
  const c = await create(page, 'Недоступная схема')
  await page.clock.install()
  await page.goto(`/?diagram=${a}`)
  await ready(page, a)
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/diagrams/${b}`, async route => {
    await gate
    await route.fulfill({ json: { id: b, title: 'Задержанная схема' } })
  })
  // History API запускает тот же переход без ожидания анимационных кадров клика.
  const navigate = (id: string) => page.evaluate(id => {
    history.pushState(null, '', `/?diagram=${id}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, id)
  const notice = page.locator('.navigation-notice')
  await navigate(b)
  await expect(page.locator('.app')).toHaveAttribute('aria-busy', 'true')
  await page.clock.runFor(399)
  await expect(notice).toHaveCount(0)
  await page.clock.runFor(1)
  await expect(notice).toBeVisible()
  release()
  await page.clock.resume()
  await ready(page, b)
  await expect(notice).toHaveCount(0)

  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  // Запоминаем даже краткое добавление уведомления между проверками.
  await page.evaluate(() => {
    const probe = { appearances: 0 }
    Object.assign(window, { noticeProbe: probe })
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('.navigation-notice') || node.querySelector('.navigation-notice'))) probe.appearances++
      }
    }).observe(document.querySelector('.app')!, { childList: true, subtree: true })
  })
  await navigate(a)
  await expect(page.locator('.app')).toHaveAttribute('aria-busy', 'false')
  await page.clock.runFor(500)
  await expect(notice).toHaveCount(0)
  await page.route(`**/api/diagrams/${c}`, route => route.fulfill({ status: 503, json: { error: 'Недоступно' } }))
  await navigate(c)
  await expect(page.getByRole('alert')).toContainText('Сервер не смог открыть схему')
  await page.clock.runFor(500)
  await expect(notice).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { noticeProbe: { appearances: number } }).noticeProbe.appearances)).toBe(0)
  await page.clock.resume()
  await ready(page, a)
})

test('switching keeps the page and header, stable identity and exactly one live socket', async ({ page }) => {
  await page.addInitScript(() => {
    const sockets: WebSocket[] = []
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        sockets.push(this)
      }
    }
    Object.assign(window, { socketStates: () => sockets.map(socket => socket.readyState) })
  })
  const a = await create(page, 'Без мерцания A')
  const b = await create(page, 'Без мерцания B')
  await page.goto(`/?diagram=${a}`)
  await ready(page, a)
  const identity = await page.locator('.avatars span').evaluate(element => ({
    id: element.getAttribute('data-user-id'), title: element.getAttribute('title'), color: getComputedStyle(element).backgroundColor,
  }))
  const timeOrigin = await page.evaluate(() => performance.timeOrigin)
  await page.evaluate(() => {
    const header = document.querySelector('header')!
    const logo = header.querySelector('img')!
    const frames = { count: 0, missingHeader: 0, falsePresence: 0 }
    Object.assign(window, { switchingFrames: frames })
    const sample = () => {
      frames.count++
      if (!header.isConnected || !logo.isConnected || header.getBoundingClientRect().height !== 48) frames.missingHeader++
      if (document.querySelector('.cell-with-presence')) frames.falsePresence++
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  for (const id of [b, a, b, a, b, a]) {
    await select(page, id)
    await ready(page, id)
    await expect(page.locator('main')).toBeFocused()
    await expect(page.locator('.avatars span')).toHaveCount(1)
    expect(await page.locator('.avatars span').evaluate(element => ({
      id: element.getAttribute('data-user-id'), title: element.getAttribute('title'), color: getComputedStyle(element).backgroundColor,
    }))).toEqual(identity)
    await expect(root(page)).not.toHaveClass(/cell-with-presence/)
    await expect.poll(() => page.evaluate(() => {
      const states = (window as unknown as { socketStates: () => number[] }).socketStates()
      return states.filter(state => state !== WebSocket.CLOSED).length
    })).toBe(1)
  }
  await root(page).dblclick()
  await page.getByRole('textbox').fill('Draft сохранён при Назад')
  await page.goBack()
  await ready(page, b)
  await page.goForward()
  await ready(page, a)
  await expect(root(page)).toHaveAttribute('data-text', 'Draft сохранён при Назад')
  await expect(page.getByRole('button', { name: 'Отменить действие', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
  const frames = await page.evaluate(() => (window as unknown as { switchingFrames: { count: number; missingHeader: number; falsePresence: number } }).switchingFrames)
  expect(frames.count).toBeGreaterThan(0)
  expect(frames.missingHeader).toBe(0)
  expect(frames.falsePresence).toBe(0)
  await page.reload()
  await ready(page, a)
  await expect(page.locator('.avatars span')).toHaveAttribute('data-user-id', identity.id!)
  await expect(page.locator('.avatars span')).toHaveAttribute('title', identity.title!)
})

test('leaving a diagram removes presence on another client but keeps genuine participants', async ({ page, browser }) => {
  const a = await create(page, 'Presence A')
  const b = await create(page, 'Presence B')
  const context = await namedContext(browser)
  const observer = await context.newPage()
  try {
    await observer.goto(`/?diagram=${a}`)
    await ready(observer, a)
    await page.goto(`/?diagram=${a}`)
    await ready(page, a)
    await expect(observer.locator('.avatars span')).toHaveCount(2)
    await expect(root(observer)).toHaveClass(/cell-with-presence/)
    for (let i = 0; i < 3; i++) {
      await select(page, b)
      await ready(page, b)
      await expect(observer.locator('.avatars span')).toHaveCount(1)
      await expect(root(observer)).not.toHaveClass(/cell-with-presence/)
      await expect(page.locator('.avatars span')).toHaveCount(1)
      await select(page, a)
      await ready(page, a)
      await expect(observer.locator('.avatars span')).toHaveCount(2)
      await expect(root(observer)).toHaveClass(/cell-with-presence/)
    }
    await page.close()
    await expect(observer.locator('.avatars span')).toHaveCount(1)
    await expect(root(observer)).not.toHaveClass(/cell-with-presence/)
  } finally { await context.close() }
})

test('late and failed loads do not replace the last selected diagram', async ({ page }) => {
  const a = await create(page, 'Переход A')
  const b = await create(page, 'Медленная B')
  const c = await create(page, 'Переход C')
  await page.goto(`/?diagram=${a}`)
  await ready(page, a)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let complete!: () => void
  const handled = new Promise<void>(resolve => { complete = resolve })
  let entered = false
  await page.route(`**/api/diagrams/${b}`, async route => {
    entered = true
    await gate
    // После AbortController браузер уже может завершить перехваченный запрос.
    if (!route.request().failure()) await route.fulfill({ json: { id: b, title: 'Медленная B' } })
    complete()
  })
  await select(page, b)
  await expect.poll(() => entered).toBe(true)
  await select(page, c)
  await ready(page, c)
  release()
  await handled
  await page.unroute(`**/api/diagrams/${b}`)
  await page.route(`**/api/diagrams/${b}`, route => route.fulfill({ status: 503, json: { error: 'Недоступно' } }))
  await select(page, b)
  await expect(page.getByRole('alert')).toContainText('Сервер не смог открыть схему')
  await ready(page, c)
  await expect(page).toHaveURL(new RegExp(`diagram/${c}$`))
  await expect(root(page)).toHaveAttribute('data-text', 'Переход C')
  await page.getByRole('button', { name: 'Закрыть сообщение' }).click()
  await select(page, a)
  await ready(page, a)
  await expect(root(page)).not.toHaveClass(/cell-with-presence/)
})
