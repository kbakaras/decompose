import { test, expect, type Page } from '@playwright/test'
import { namedContext } from './fixtures'

const root = (page: Page) => page.locator('[data-cell-id="root"]')
const profile = (page: Page) => page.getByRole('dialog', { name: 'Представься', exact: true })
async function create(page: Page, title = 'Профиль') {
  const response = await page.request.post('/api/diagrams', { data: { title } })
  expect(response.status()).toBe(201)
  return `/?diagram=${(await response.json()).id}`
}
async function ready(page: Page) {
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
}
async function introduce(page: Page, name: string) {
  await page.getByRole('button', { name: 'Представиться', exact: true }).click()
  await page.getByLabel('Имя', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click()
}

test('guest can browse; all keyboard and menu edits ask, cancellation changes nothing, confirmation continues once', async ({ page }) => {
  await page.goto(await create(page))
  await ready(page)
  await expect(page.locator('.avatars span')).toHaveCount(0)
  await expect(page.locator('.guest-count')).toHaveText('Гостей: 1')
  for (const key of ['Tab', 'Enter', 'F2', 'Space', 'Delete', 'Control+ArrowUp', 'Control+ArrowRight', 'Shift+Tab']) {
    await root(page).click()
    await page.keyboard.press(key)
    await expect(profile(page)).toBeVisible()
    await expect(page.getByLabel('Имя', { exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(profile(page)).toHaveCount(0)
    await expect(page.locator('[data-cell-id]')).toHaveCount(1)
    await expect(root(page)).toHaveAttribute('data-text', 'Профиль')
    await expect(root(page)).toHaveAttribute('data-status', 'open')
  }
  await root(page).dblclick()
  await expect(profile(page)).toBeVisible()
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  await page.getByRole('button', { name: 'Действия с клеточкой' }).click()
  await page.getByRole('button', { name: 'Статус', exact: false }).click()
  await expect(profile(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await root(page).click()
  await page.keyboard.press('Tab')
  await page.getByLabel('Имя', { exact: true }).fill('  ')
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click()
  await expect(profile(page).getByRole('alert')).toBeVisible()
  await page.getByLabel('Имя', { exact: true }).fill('  Анна Иванова  ')
  await page.keyboard.press('Enter')
  await expect(profile(page)).toHaveCount(0)
  await expect(page.locator('[data-cell-id]')).toHaveCount(2)
  await expect(page.getByRole('textbox', { name: 'Текст клеточки' })).toBeFocused()
  await page.getByRole('textbox', { name: 'Текст клеточки' }).fill('Один ребёнок')
  await page.keyboard.press('Enter')
  await expect(page.locator('.identity-trigger span')).toHaveAttribute('title', 'Анна Иванова (ты)')
  await expect(page.locator('.identity-trigger span')).toHaveText('АИ')
  await expect(page.locator('.guest-count')).toHaveCount(0)
})

test('profile survives reload, switching and offline; rename keeps identity, connection and undo', async ({ page, context }) => {
  await page.addInitScript(() => {
    const Native = window.WebSocket
    let connections = 0
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); connections++ }
    }
    Object.assign(window, { connectionCount: () => connections })
  })
  const a = await create(page, 'Первая')
  const b = await create(page, 'Вторая')
  await page.goto(a)
  await ready(page)
  const id = await page.evaluate(() => localStorage.getItem('decompose:participant:v1'))
  await introduce(page, 'Борис')
  await root(page).click()
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Изменить имя' }).click()
  await page.getByLabel('Имя', { exact: true }).fill('Борис Петров')
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => (window as unknown as { connectionCount: () => number }).connectionCount())).toBe(1)
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
  await expect(root(page)).toHaveAttribute('data-status', 'open')
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.locator(`.diagrams-list a[href="${b}"]`).click()
  await ready(page)
  await page.reload()
  await ready(page)
  await expect(page.locator('.identity-trigger span')).toHaveAttribute('data-user-id', id!)
  await expect(page.locator('.identity-trigger span')).toHaveAttribute('title', 'Борис Петров (ты)')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await context.setOffline(true)
  await page.reload()
  await ready(page)
  await root(page).dblclick()
  await expect(page.getByRole('textbox', { name: 'Текст клеточки' })).toBeFocused()
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 375, height: 667 })
  await expect(page.getByRole('button', { name: 'Изменить имя' })).toBeInViewport()
})

test('guests are counted per browser, hidden on cells, and names sync across tabs and to peers', async ({ page, context, browser }) => {
  const url = await create(page)
  await page.goto(url)
  await ready(page)
  const tab = await context.newPage()
  const remoteContext = await browser.newContext()
  const remote = await remoteContext.newPage()
  try {
    await tab.goto(url)
    await remote.goto(url)
    await ready(tab)
    await ready(remote)
    await expect(page.locator('.guest-count')).toHaveText('Гостей: 2')
    await expect(remote.locator('.guest-count')).toHaveText('Гостей: 2')
    await root(page).click()
    await root(tab).click()
    await expect(remote.locator('.avatars span, .cell-with-presence')).toHaveCount(0)
    await introduce(page, 'Вера')
    await expect(tab.locator('.identity-trigger span')).toHaveAttribute('title', 'Вера (ты)')
    await expect(remote.locator('.avatars span')).toHaveCount(1)
    await expect(remote.locator('.remote-avatar')).toHaveAttribute('title', 'Вера')
    await expect(remote.locator('.guest-count')).toHaveText('Гостей: 1')
    await expect(root(remote)).toHaveClass(/cell-with-presence/)
    // Проверяем обработчики ухода в back-forward cache: скрытая сессия не должна воскреснуть от смены имени.
    await tab.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await page.getByRole('button', { name: 'Изменить имя' }).click()
    await page.getByLabel('Имя', { exact: true }).fill('Вера Иванова')
    await page.keyboard.press('Enter')
    await expect(tab.locator('.identity-trigger span')).toHaveAttribute('title', 'Вера Иванова (ты)')
    await expect(remote.locator('.remote-avatar')).toHaveAttribute('title', 'Вера Иванова')
    await tab.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await expect(tab.getByTestId('connection')).toHaveAttribute('data-connected', 'true')
    await expect(remote.locator('.avatars span')).toHaveCount(1)
    await root(page).dblclick()
    await expect(root(remote)).toHaveAttribute('data-editing-by', 'Вера Иванова')
    await page.keyboard.press('Escape')
    await tab.close()
    await page.close()
    await expect(remote.locator('.avatars span, .cell-with-presence')).toHaveCount(0)
  } finally { await remoteContext.close() }
})

test('creating a diagram requires a name and browser navigation cancels a pending edit', async ({ page }) => {
  const a = await create(page, 'До перехода')
  const b = await create(page, 'После перехода')
  await page.goto(a)
  await ready(page)
  let posts = 0
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/diagrams')) posts++ })
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.getByLabel('Новая схема', { exact: true }).fill('Создана после знакомства')
  await page.getByRole('button', { name: 'Создать', exact: true }).click()
  await expect(profile(page)).toBeVisible()
  expect(posts).toBe(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Создать', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await root(page).click()
  await page.keyboard.press('Space')
  await expect(profile(page)).toBeVisible()
  await page.evaluate(url => {
    history.pushState(null, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, b)
  await expect(profile(page)).toHaveCount(0)
  await ready(page)
  await expect(root(page)).toHaveAttribute('data-text', 'После перехода')
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.getByLabel('Новая схема', { exact: true }).fill('Создана после знакомства')
  await page.getByRole('button', { name: 'Создать', exact: true }).click()
  await page.getByLabel('Имя', { exact: true }).fill('Григорий')
  await page.keyboard.press('Enter')
  await expect(root(page)).toHaveAttribute('data-text', 'Создана после знакомства')
  expect(posts).toBe(1)
  await page.goto(a)
  await ready(page)
  await expect(root(page)).toHaveAttribute('data-status', 'open')
})

test('storage failure warns instead of blocking editing; guest profile control fits on mobile', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function(key: string, value: string) {
      if (key.startsWith('decompose:participant')) throw new DOMException('Blocked', 'SecurityError')
      original.call(this, key, value)
    }
  })
  await page.goto(await create(page))
  await ready(page)
  await page.setViewportSize({ width: 375, height: 667 })
  await expect(page.getByRole('button', { name: 'Представиться', exact: true })).toBeInViewport()
  for (const label of ['Отменить действие', 'Повторить действие', 'Вся схема', 'Клавиши', 'Действия с клеточкой']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeInViewport()
  }
  await introduce(page, 'Дарья')
  await expect(page.getByRole('alert')).toContainText('После перезагрузки придётся представиться снова')
  await page.getByRole('button', { name: 'Закрыть предупреждение профиля' }).click()
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  await root(page).dblclick()
  await expect(page.getByRole('textbox', { name: 'Текст клеточки' })).toBeFocused()
})

async function child(page: Page, text: string) {
  await root(page).click()
  await page.keyboard.press('Tab')
  await page.getByRole('textbox', { name: 'Текст клеточки' }).fill(text)
  await page.keyboard.press('Enter')
  return (await page.locator('[data-active="true"]').getAttribute('data-cell-id'))!
}

for (const stale of [false, true]) test(`guest drag waits for a name and ${stale ? 'rejects a changed sibling snapshot' : 'continues exactly once'}`, async ({ page, browser }) => {
  const url = await create(page)
  const authorContext = await namedContext(browser)
  const author = await authorContext.newPage()
  try {
    await author.goto(url)
    await ready(author)
    const a = await child(author, 'A')
    const b = await child(author, 'B')
    const c = await child(author, 'C')
    await page.goto(url)
    await ready(page)
    const cell = (target: Page, id: string) => target.locator(`[data-cell-id="${id}"]`)
    const drag = async () => {
      await page.getByRole('button', { name: 'Вся схема' }).click()
      await cell(page, c).click()
      await expect(cell(page, c)).toHaveClass(/cell-draggable/)
      const from = (await cell(page, c).boundingBox())!
      const to = (await cell(page, a).boundingBox())!
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 20, { steps: 15 })
      await expect(page.getByTestId('drop-indicator')).toBeVisible()
      await page.mouse.up()
      await expect(profile(page)).toBeVisible()
      await expect(cell(page, c)).toHaveAttribute('data-order', '2')
      await expect(cell(author, c)).toHaveAttribute('data-order', '2')
      await expect(cell(page, c)).not.toHaveClass(/cell-dragging/)
    }
    await drag()
    await page.keyboard.press('Escape')
    await expect(cell(page, c)).toHaveAttribute('data-order', '2')
    await drag()
    if (stale) {
      await cell(author, b).click()
      await author.keyboard.press('Delete')
      await expect(cell(page, b)).toHaveCount(0)
    }
    await page.getByLabel('Имя', { exact: true }).fill('Перетаскиватель')
    await page.keyboard.press('Enter')
    if (stale) {
      await expect(page.getByRole('alert')).toContainText('Повтори перетаскивание')
      await expect(cell(author, c)).toHaveAttribute('data-order', '1')
      await expect(page.getByRole('button', { name: 'Отменить действие', exact: true })).toBeDisabled()
    } else {
      await expect(cell(page, c)).toHaveAttribute('data-order', '0')
      await expect(cell(author, c)).toHaveAttribute('data-order', '0')
      await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
      await expect(cell(page, c)).toHaveAttribute('data-order', '2')
      await expect(page.getByRole('button', { name: 'Отменить действие', exact: true })).toBeDisabled()
    }
  } finally { await authorContext.close() }
})

test('a cell deleted while the name form is open is not edited after confirmation', async ({ page, browser }) => {
  const url = await create(page)
  const authorContext = await namedContext(browser)
  const author = await authorContext.newPage()
  try {
    await author.goto(url)
    await ready(author)
    const id = await child(author, 'Исчезающая клеточка')
    await page.goto(url)
    await ready(page)
    const target = page.locator(`[data-cell-id="${id}"]`)
    await target.dblclick()
    await expect(profile(page)).toBeVisible()
    await author.keyboard.press('Delete')
    await expect(target).toHaveCount(0)
    await page.getByLabel('Имя', { exact: true }).fill('Наблюдатель')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('alert')).toContainText('Клеточка больше не видна')
    await expect(page.getByRole('textbox', { name: 'Текст клеточки' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Отменить действие', exact: true })).toBeDisabled()
  } finally { await authorContext.close() }
})
