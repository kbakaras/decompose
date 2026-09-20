import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, namedContext, type Page } from './fixtures'

// Сохранённые файловые дескрипторы проверяем в обычном профиле, не incognito.
test.use({
  channel: 'chromium',
  context: async ({ playwright, baseURL }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'decompose-file-browser-'))
    const context = await playwright.chromium.launchPersistentContext(directory, { headless: true, channel: 'chromium', baseURL })
    await context.addInitScript(() => localStorage.setItem('decompose:participant-name:v1', 'Участник теста'))
    try { await use(context) } finally { await context.close(); await rm(directory, { recursive: true, force: true }) }
  },
})

const file = { format: 'decompose', version: 1, nodes: [
  { id: 'r', text: 'Файл схемы', status: 'open', children: ['a'] },
  { id: 'a', text: 'Сохранённая\nкарточка', status: 'done', children: [] },
], settings: { textAlign: 'center' } }
const root = (page: Page) => page.locator('[data-cell-id="root"]')
const ready = (page: Page) => expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
async function fileDialog(page: Page, mode: 'new' | 'replace' | 'disk' = 'new') {
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  if (mode === 'replace') { await page.getByRole('button', { name: 'Заменить из файла', exact: true }).click(); return }
  await page.getByRole('tablist', { name: 'Раздел каталога' }).getByRole('tab', { name: 'Файлы', exact: true }).click()
  await page.getByRole('button', { name: mode === 'disk' ? 'Открыть файл на диске' : 'Новая схема из файла', exact: true }).click()
}
async function upload(page: Page) {
  await page.getByLabel('Файл схемы', { exact: true }).setInputFiles({ name: 'test.deco', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) })
}

test('native file imports as a new diagram and exports the active draft, formatting and order', async ({ page }) => {
  await page.goto('/'); await ready(page)
  await fileDialog(page); await upload(page)
  await expect(root(page)).toHaveAttribute('data-text', 'Файл схемы')
  await expect(page.locator('.file-indicator')).toHaveCount(0)
  await expect(page.locator('[data-cell-id]')).toHaveCount(2)
  await expect(root(page).locator('.cell-text')).toHaveCSS('text-align', 'center')
  await root(page).dblclick(); await page.getByRole('textbox', { name: 'Текст клеточки' }).fill('Draft в файле')
  const download = page.waitForEvent('download')
  await page.keyboard.press('Control+s')
  const exported = await download
  expect(exported.suggestedFilename()).toBe('Draft в файле.deco')
  const data = JSON.parse(await readFile((await exported.path())!, 'utf8'))
  expect(data.nodes.map((node: { text: string }) => node.text)).toEqual(['Draft в файле', 'Сохранённая\nкарточка'])
  expect(data.settings).toEqual({ textAlign: 'center' })
  expect(data.nodes[1].status).toBe('done')
  await page.reload(); await ready(page); await expect(root(page)).toHaveAttribute('data-text', 'Draft в файле')
})

test('replacement drains online drafts, reloads peers, and quarantines an offline generation', async ({ page, browser }) => {
  const response = await page.request.post('/api/diagrams', { data: { title: 'До замены' } })
  const { id } = await response.json(), url = `/diagram/${id}`
  const onlineContext = await namedContext(browser), offlineContext = await namedContext(browser)
  try {
    const peer = await onlineContext.newPage(), offline = await offlineContext.newPage()
    for (const client of [page, peer, offline]) { await client.goto(url); await ready(client) }
    await offlineContext.setOffline(true)
    await root(offline).dblclick(); await offline.getByRole('textbox').fill('Offline: не терять'); await offline.keyboard.press('Enter')
    await root(peer).dblclick(); await peer.getByRole('textbox').fill('Draft другого участника')
    await fileDialog(page, 'replace'); await upload(page)
    await page.getByRole('button', { name: 'Заменить схему', exact: true }).click()
    for (const client of [page, peer]) {
      await expect(root(client)).toHaveAttribute('data-text', 'Файл схемы')
      await expect(client.getByRole('button', { name: 'Отменить действие', exact: true })).toBeDisabled()
    }
    expect(page.url()).toContain(url)
    await offlineContext.setOffline(false)
    await expect(offline.getByRole('alert')).toContainText('Схема заменена')
    await expect(root(offline)).toHaveAttribute('data-text', 'Offline: не терять')
    await expect(root(page)).toHaveAttribute('data-text', 'Файл схемы')
    await offline.getByRole('button', { name: 'Открыть актуальную схему' }).click()
    await expect(root(offline)).toHaveAttribute('data-text', 'Файл схемы')
  } finally { await onlineContext.close(); await offlineContext.close() }
})

// Реальный WritableFileStream браузера; нативный диалог и разрешение заменены только в тесте.
async function installFilePicker(page: Page, name = 'diagram-test.json') {
  await page.evaluate(async ({ contents, name }) => {
    const directory = await navigator.storage.getDirectory()
    const handle = await directory.getFileHandle(name, { create: true })
    const writer = await handle.createWritable(); await writer.write(contents); await writer.close()
    Object.assign(window, {
      showOpenFilePicker: async (options: unknown) => { Object.assign(window, { openOptions: options }); return [handle] },
    })
  }, { contents: JSON.stringify(file), name })
}
async function diskText(page: Page) {
  return page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('diagram-test.json')).getFile()).text())
}

async function internalDialog(page: Page) {
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  const current = page.getByRole('region', { name: 'Текущая схема' })
  await expect(current).toContainText('Файл на диске')
  await expect(current.getByRole('button')).toHaveText(['Поделиться сессией', 'Сохранить как внутреннюю', 'Скачать копию'])
  await page.getByRole('button', { name: 'Сохранить как внутреннюю' }).click()
}

test('owner and guest download a copy directly without changing the file or ending sharing', async ({ page, browser }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url(), invite = await shareDisk(page), contents = await diskText(page)
  const context = await namedContext(browser)
  try {
    const guest = await context.newPage(); await guest.goto(invite); await ready(guest)
    for (const client of [page, guest]) {
      const url = client.url()
      await client.getByRole('button', { name: 'Схемы', exact: true }).click()
      const files = client.getByRole('tab', { name: 'Файлы', exact: true })
      await expect(files).toHaveAttribute('aria-selected', 'true')
      await expect(files).toBeFocused()
      await client.getByRole('tab', { name: 'Схемы', exact: true }).click()
      await client.keyboard.press('Escape')
      await client.getByRole('button', { name: 'Схемы', exact: true }).click()
      await expect(files).toHaveAttribute('aria-selected', 'true')
      await expect(files).toBeFocused()
      const download = client.waitForEvent('download')
      await client.getByRole('button', { name: 'Скачать копию', exact: true }).click()
      const copy = await download
      expect(copy.suggestedFilename()).toBe('Файл схемы.deco')
      expect(JSON.parse(await readFile((await copy.path())!, 'utf8')).nodes[0].text).toBe('Файл схемы')
      await expect(client.getByRole('dialog')).toHaveCount(0)
      await expect(client.locator('main')).toBeFocused()
      expect(client.url()).toBe(url)
      await expect(client.getByTestId('connection')).toHaveAttribute('data-connected', 'true')
    }
    expect(page.url()).toBe(localUrl)
    expect(await diskText(page)).toBe(contents)
    await expect(guest.getByRole('alert')).toHaveCount(0)
  } finally { await context.close() }
})

test('disk to internal saves accepted shared edits, ends the room and disconnects from the intact file', async ({ page, browser }) => {
  await page.goto('http://127.0.0.1:4183/decompose/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url(), invite = await shareDisk(page)
  const context = await namedContext(browser)
  try {
    const guest = await context.newPage(); await guest.goto(invite); await ready(guest)
    await guest.getByRole('button', { name: 'Схемы', exact: true }).click()
    await expect(guest.getByRole('region', { name: 'Текущая схема' }).getByRole('button')).toHaveText(['Скачать копию'])
    await expect(guest.getByRole('tablist', { name: 'Раздел каталога' }).getByRole('tab')).toHaveText(['Схемы', 'Задачи', 'Файл'])
    await guest.getByRole('button', { name: 'Закрыть список схем' }).click()
    await root(guest).dblclick(); await guest.getByRole('textbox', { name: 'Текст клеточки' }).fill('Принято от участника'); await guest.keyboard.press('Enter')
    await expect(root(page)).toHaveAttribute('data-text', 'Принято от участника')
    await internalDialog(page)
    await page.getByRole('button', { name: 'Отмена', exact: true }).click()
    expect(page.url()).toBe(localUrl)
    await expect(guest.locator('.file-notice')).toHaveCount(0)
    await internalDialog(page)
    await page.getByRole('button', { name: 'Сохранить и перейти' }).click()
    await expect(page).toHaveURL(/\/decompose\/diagram\/[\da-f-]{36}$/); await ready(page)
    await expect(page.locator('.file-indicator')).toHaveCount(0)
    await expect(root(page)).toHaveAttribute('data-text', 'Принято от участника')
    await expect(root(page).locator('.cell-text')).toHaveCSS('text-align', 'center')
    await expect(page.locator('[data-status="done"]')).toHaveCount(1)
    await expect(guest.getByRole('alert')).toContainText('завершена')
    expect(guest.url()).toBe(invite)
    const saved = await diskText(page)
    expect(JSON.parse(saved).nodes[0].text).toBe('Принято от участника')
    await root(page).dblclick(); await page.getByRole('textbox', { name: 'Текст клеточки' }).fill('Только внутри'); await page.keyboard.press('Enter')
    await page.keyboard.press('Control+s')
    expect(await diskText(page)).toBe(saved)
    await page.goto(localUrl); await ready(page)
    await expect(root(page)).toHaveAttribute('data-text', 'Принято от участника')
  } finally { await context.close() }
})

test('failed internal save keeps the disk editor and allows retry without losing data', async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url()
  await page.route('**/api/diagrams/import', route => route.fulfill({ status: 503, json: { error: 'Сервер недоступен' } }))
  await internalDialog(page); await page.getByRole('button', { name: 'Сохранить и перейти' }).click()
  await expect(page.getByRole('alert')).toContainText('Сервер недоступен')
  expect(page.url()).toBe(localUrl)
  expect(JSON.parse(await diskText(page)).nodes[0].text).toBe('Файл схемы')
  await page.unroute('**/api/diagrams/import')
  await page.getByRole('button', { name: 'Сохранить и перейти' }).click()
  await expect(page).toHaveURL(/\/diagram\/[\da-f-]{36}$/); await ready(page)
  await expect(root(page)).toHaveAttribute('data-text', 'Файл схемы')
})

test('external file conflict prevents creating an internal copy', async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url(), before = await (await page.request.get('/api/diagrams')).json()
  await page.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('diagram-test.json')
    const writer = await handle.createWritable(); await writer.write('Внешние изменения'); await writer.close()
  })
  await internalDialog(page); await page.getByRole('button', { name: 'Сохранить и перейти' }).click()
  await expect(page.getByRole('dialog', { name: 'Сохранить как внутреннюю схему' }).getByRole('alert')).toBeVisible()
  expect(page.url()).toBe(localUrl)
  expect(await diskText(page)).toBe('Внешние изменения')
  expect(await (await page.request.get('/api/diagrams')).json()).toEqual(before)
})

test('disk mode writes the original file, shares in memory, pauses guests and never caches content', async ({ page, browser }) => {
  const sockets: string[] = []
  page.on('websocket', socket => sockets.push(socket.url()))
  await page.goto('http://127.0.0.1:4183/decompose/'); await ready(page); await installFilePicker(page)
  const cachesBefore = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name).filter(name => name?.startsWith('decompose:')))
  const catalogBefore = await (await page.request.get('/api/diagrams')).json()
  await fileDialog(page, 'disk')
  await expect(root(page)).toHaveAttribute('data-text', 'Файл схемы')
  expect(page.url()).toMatch(/\/file\/local\/[\da-f-]{36}/)
  const localUrl = page.url()
  const indicator = page.locator('.file-indicator')
  await expect(indicator).toContainText('Файл на диске')
  await expect(indicator).toContainText('diagram-test.json')
  await expect(indicator).toHaveAttribute('data-state', 'saved')
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.getByRole('button', { name: 'Поделиться сессией' }).click()
  const link = page.getByLabel('Ссылка файловой сессии')
  await expect(link).toBeVisible()
  const invite = await link.inputValue()
  expect(page.url()).toBe(localUrl)
  expect(invite).not.toBe(localUrl)
  const metadata = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('decompose-file-handles-v1')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<{ keys: string[]; native: boolean; serialized: string }>((resolve, reject) => {
        const request = db.transaction('files').objectStore('files').getAll()
        request.onsuccess = () => {
          const record = request.result[0]
          resolve({ keys: Object.keys(record).sort(), native: record.handle instanceof FileSystemFileHandle, serialized: JSON.stringify(record) })
        }
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
  })
  expect(metadata.keys).toEqual(['handle', 'id', 'room'])
  expect(Object.keys(JSON.parse(metadata.serialized).room).sort()).toEqual(['base', 'secret'])
  expect(JSON.parse(metadata.serialized).id).toBe(new URL(invite).pathname.split('/').at(-1))
  expect(metadata.native).toBe(true)
  expect(metadata.serialized).not.toContain('Сохранённая')
  expect(metadata.serialized).not.toContain('Файл схемы')
  expect(invite).toContain('http://127.0.0.1:4183/decompose/file/session/')
  expect(sockets).toContain('ws://127.0.0.1:4183/decompose/file-collaboration')
  await page.getByRole('button', { name: 'Готово', exact: true }).click()
  const guestContext = await namedContext(browser)
  try {
    const guest = await guestContext.newPage(); await guest.goto(invite); await ready(guest)
    await expect(guest.locator('.file-mode')).toHaveText('По ссылке')
    await expect(guest.locator('.file-name')).toHaveText('diagram-test.json')
    await expect(guest.locator('.file-name')).toHaveCSS('border-left-style', 'solid')
    await expect(guest.locator('.file-name')).toHaveCSS('border-left-width', '1px')
    await expect(guest.locator('.file-indicator')).toHaveAttribute('aria-label', /По ссылке — diagram-test.json —/)
    await guest.reload(); await ready(guest)
    await expect(guest.locator('.file-name')).toHaveText('diagram-test.json')
    await expect(guest.locator('.file-indicator')).toContainText('Сохраняет владелец')
    await expect(guest.locator('.file-notice')).toHaveCount(0)
    await root(guest).dblclick(); await guest.getByRole('textbox').fill('Изменено гостем'); await guest.keyboard.press('Enter')
    await expect(root(page)).toHaveAttribute('data-text', 'Изменено гостем')
    await expect.poll(() => diskText(page)).toContain('Изменено гостем')
    await expect(indicator).toHaveAttribute('data-state', 'saved')
    await expect(guest.locator('.file-notice')).toHaveCount(0)
    expect(await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name).filter(name => name?.startsWith('decompose:')))).toEqual(cachesBefore)
    expect(await guest.evaluate(async () => (await indexedDB.databases()).map(db => db.name).filter(name => name?.startsWith('decompose:')))).toEqual([])
    expect(await (await page.request.get('/api/diagrams')).json()).toEqual(catalogBefore)
    expect(await guest.evaluate(() => Object.values(localStorage).join('\n'))).not.toContain('Изменено гостем')
    await page.context().setOffline(true)
    await expect(guest.getByRole('alert')).toContainText('приостановлена')
    await expect(guest.locator('.file-indicator')).toContainText('Только просмотр')
    await expect(guest.locator('.file-name')).toHaveText('diagram-test.json')
    await root(guest).dblclick(); await expect(guest.getByRole('textbox', { name: 'Текст клеточки' })).toHaveCount(0)
    await page.context().setOffline(false)
    await expect(guest.locator('.file-notice')).toHaveCount(0)
    await page.locator('a.brand').click(); await ready(page)
    await expect(indicator).toHaveCount(0)
    await expect(guest.getByRole('alert')).toContainText('завершена')
    await expect(guest.locator('.file-indicator')).toContainText('Подключение завершено')
  } finally { await guestContext.close() }
})

test('external file modification stops autosave and leaving offers a non-browser confirmation', async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page)
  await openDisk(page)
  await page.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('diagram-test.json')
    const writer = await handle.createWritable(); await writer.write('Внешнее изменение'); await writer.close()
  })
  await root(page).dblclick(); await page.getByRole('textbox').fill('Мои изменения'); await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toContainText('изменён другой программой')
  await expect(page.getByRole('alert').getByRole('button', { name: 'Скачать копию' })).toBeVisible()
  await expect(page.getByRole('alert').getByRole('button', { name: 'Закрыть сообщение' })).toHaveCount(0)
  await expect(page.locator('.file-indicator')).toContainText('Файл на диске')
  await expect(page.locator('.file-indicator')).toContainText('Не сохранено')
  await expect(page.locator('.file-indicator')).toHaveAttribute('data-state', 'error')
  expect((await page.locator('.file-notice').boundingBox())!.height).toBeLessThan(200)
  expect(await diskText(page)).toBe('Внешнее изменение')
  await page.locator('a.brand').click()
  await expect(page.getByRole('dialog', { name: 'Несохранённый файл' })).toBeVisible()
  await page.getByRole('button', { name: 'Остаться', exact: true }).click()
  await expect(root(page)).toHaveAttribute('data-text', 'Мои изменения')
  await page.locator('a.brand').click(); await page.getByRole('button', { name: 'Уйти без сохранения' }).click()
  await expect(page).not.toHaveURL(/\/file\/local\//)
})

test('disk mode stays visible in a compact header with a long filename and on a narrow screen', async ({ page }) => {
  const name = `${'Длинное имя файла '.repeat(5)}.deco`
  await page.goto('/'); await ready(page); await installFilePicker(page, name)
  const normalStyle = await page.locator('.diagram-trigger').evaluate(element => {
    const style = getComputedStyle(element)
    return { font: style.font, borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle,
      radius: style.borderTopLeftRadius, height: element.getBoundingClientRect().height, background: style.backgroundColor }
  })
  expect(normalStyle.borderWidth).toBe('1px')
  expect(normalStyle.borderStyle).toBe('solid')
  expect(normalStyle.radius).toBe('4px')
  expect(normalStyle.background).toBe('rgba(0, 0, 0, 0)')
  await openDisk(page)
  expect(await page.evaluate(() => (window as unknown as { openOptions: unknown }).openOptions)).toMatchObject({
    multiple: false, types: [{ accept: { 'application/json': ['.deco', '.json'] } }],
  })
  const fileStyle = await page.locator('.file-indicator').evaluate(element => {
    const style = getComputedStyle(element)
    return { font: style.font, borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle,
      radius: style.borderTopLeftRadius, height: element.getBoundingClientRect().height, background: style.backgroundColor }
  })
  expect(fileStyle).toEqual({ ...normalStyle, background: 'rgb(228, 239, 245)' })
  for (const selector of ['.file-mode', '.file-name', '.file-save-state']) {
    expect(await page.locator(selector).evaluate(element => getComputedStyle(element).font)).toBe(normalStyle.font)
  }
  await expect(page.locator('.file-name')).toHaveText(name)
  await expect(page.locator('.file-name')).toHaveCSS('border-left-style', 'solid')
  await expect(page.locator('.file-name')).toHaveCSS('border-left-width', '1px')
  await expect(page.locator('.file-indicator')).toHaveAttribute('title', `Файл на диске — ${name} — Сохранено`)
  await expect(page.locator('.document-title')).not.toContainText('Файл схемы')
  await expect(page.locator('.document-title > *')).toHaveCount(1)
  const trigger = page.locator('.document-title').getByRole('button', { name: 'Схемы', exact: true })
  await expect(trigger.locator('.file-indicator')).toHaveCount(1)
  for (const width of [1280, 768, 701, 390, 375]) {
    await page.setViewportSize({ width, height: 720 })
    if (width <= 700) await expect(page.locator('.file-name')).toBeHidden()
    await expect(page.locator('.file-mode')).toBeVisible()
    const header = (await page.locator('.topbar').boundingBox())!
    const label = (await page.locator('.file-mode').boundingBox())!
    const title = (await page.locator('.document-title').boundingBox())!
    expect(header.height).toBe(48)
    expect(label.x).toBeGreaterThanOrEqual(title.x)
    expect(label.x + label.width).toBeLessThanOrEqual(title.x + title.width)
    expect(label.y + label.height).toBeLessThanOrEqual(header.y + header.height)
    await expect(page.locator('.file-menu-arrow')).toBeInViewport()
    const arrow = (await page.locator('.file-menu-arrow').boundingBox())!
    expect(arrow.x + arrow.width).toBeLessThanOrEqual(title.x + title.width)
    expect(await page.locator('.topbar').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const metrics = await page.evaluate(() => {
      const baseline = (selector: string) => {
        const marker = document.createElement('span')
        marker.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline'
        document.querySelector(selector)!.append(marker)
        const y = marker.getBoundingClientRect().top
        marker.remove()
        return y
      }
      const center = (selector: string) => {
        const bounds = document.querySelector(selector)!.getBoundingClientRect()
        return bounds.top + bounds.height / 2
      }
      return { brand: baseline('.brand-name'), mode: baseline('.file-mode'),
        badgeCenter: center('.file-indicator'), actionCenter: center('.actions > button') }
    })
    if (width > 700) expect(Math.abs(metrics.brand - metrics.mode)).toBeLessThan(0.5)
    else expect(Math.abs(metrics.badgeCenter - metrics.actionCenter)).toBeLessThan(0.5)
    await page.locator('.file-mode').click()
    await expect(page.getByRole('dialog', { name: 'Выбор схемы для редактирования', exact: true })).toBeVisible()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(page.locator('main')).toBeFocused()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  }
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Выбор схемы для редактирования', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.screenshot({ path: 'test-results/file-header-mobile.png' })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.screenshot({ path: 'test-results/file-header.png' })
})

test('an active file draft warns before unload and a hard reload reopens the same file', async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page)
  await openDisk(page)
  await root(page).dblclick(); await page.getByRole('textbox').fill('Draft перед закрытием')
  expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(false)
  await expect.poll(() => diskText(page)).toContain('Draft перед закрытием')
  const url = page.url()
  const cdp = await page.context().newCDPSession(page)
  await Promise.all([page.waitForEvent('load'), cdp.send('Page.reload', { ignoreCache: true })]); await ready(page)
  await expect(root(page)).toHaveAttribute('data-text', 'Draft перед закрытием')
  expect(page.url()).toBe(url)
  await expect(page.locator('.file-mode')).toHaveText('Файл на диске')
  await root(page).dblclick(); await page.getByRole('textbox').fill('После перезагрузки'); await page.keyboard.press('Enter')
  await expect.poll(() => diskText(page)).toContain('После перезагрузки')
})

async function openDisk(page: Page) {
  await fileDialog(page, 'disk')
  await expect(page).toHaveURL(/\/file\/local\/[\da-f-]{36}/); await ready(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test('disk selection starts directly from the menu; cancellation and errors leave the current scheme focused', async ({ page }) => {
  await page.goto('/'); await ready(page)
  const url = page.url()
  await root(page).click()
  await page.evaluate(() => Object.assign(window, {
    pickerCalls: 0,
    showOpenFilePicker: async () => {
      const probe = window as unknown as { pickerCalls: number; pickerGesture: boolean; pickerModal: boolean }
      probe.pickerCalls++; probe.pickerGesture = navigator.userActivation.isActive
      probe.pickerModal = !!document.querySelector('dialog[open]')
      throw new DOMException('Отмена', 'AbortError')
    },
  }))
  await fileDialog(page, 'disk')
  expect(await page.evaluate(() => {
    const probe = window as unknown as { pickerCalls: number; pickerGesture: boolean; pickerModal: boolean }
    return [probe.pickerCalls, probe.pickerGesture, probe.pickerModal]
  })).toEqual([1, true, false])
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.canvas')).toBeFocused()
  expect(page.url()).toBe(url)

  await page.evaluate(() => Object.assign(window, { showOpenFilePicker: async () => { throw new Error('Файл недоступен') } }))
  await fileDialog(page, 'disk')
  await expect(page.getByRole('alert')).toContainText('Файл недоступен')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.canvas')).toBeFocused()
  expect(page.url()).toBe(url)
  await installFilePicker(page); await openDisk(page)
  await expect(root(page)).toHaveAttribute('data-text', 'Файл схемы')
})

test('a late native selection cannot replace a scheme opened in the meantime', async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page)
  const { id } = await (await page.request.post('/api/diagrams', { data: { title: 'Другая схема' } })).json()
  await page.evaluate(() => {
    const picker = (window as unknown as { showOpenFilePicker: () => Promise<unknown> }).showOpenFilePicker
    Object.assign(window, { showOpenFilePicker: () => new Promise(resolve => {
      Object.assign(window, { completePicker: async () => resolve(await picker()) })
    }) })
  })
  await fileDialog(page, 'disk')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.evaluate(id => { history.pushState(null, '', `/diagram/${id}`); dispatchEvent(new PopStateEvent('popstate')) }, id)
  await expect(root(page)).toHaveAttribute('data-text', 'Другая схема')
  await page.evaluate(async () => { await (window as unknown as { completePicker: () => Promise<void> }).completePicker() })
  await expect(page).toHaveURL(new RegExp(`/diagram/${id}$`))
  await expect(page.locator('.file-indicator')).toHaveCount(0)
})
async function shareDisk(page: Page) {
  const ownerUrl = page.url()
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.getByRole('button', { name: 'Поделиться сессией' }).click()
  const link = page.getByLabel('Ссылка файловой сессии')
  await expect(link).toBeVisible()
  const url = await link.inputValue()
  expect(page.url()).toBe(ownerUrl)
  expect(new URL(ownerUrl).pathname).toContain('/file/local/')
  expect(new URL(url).pathname).toContain('/file/session/')
  expect(new URL(url).pathname.split('/').at(-1)).toBe(new URL(ownerUrl).pathname.split('/').at(-1))
  await page.getByRole('button', { name: 'Готово', exact: true }).click()
  await expect(page.locator('main')).toBeFocused()
  return url
}

test('sharing a local file preserves the owner editor, selection, undo and bounded autosaves', async ({ page, browser }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    let writes = 0
    const original = FileSystemFileHandle.prototype.createWritable
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      writes++
      return original.apply(this, args)
    }
    Object.assign(window, { fileWrites: () => writes })
  })
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const child = page.locator('[data-cell-id]:not([data-cell-id="root"])')
  await child.click(); await page.keyboard.press('Space')
  const selected = await child.getAttribute('data-cell-id')
  const main = await page.locator('main').elementHandle()
  const ownerUrl = page.url()
  const timeOrigin = await page.evaluate(() => performance.timeOrigin)
  const transform = await page.locator('.react-flow__viewport').getAttribute('style')
  const invite = await shareDisk(page)
  await expect(page.getByTestId('connection')).toHaveAttribute('data-connected', 'true')
  expect(await main!.evaluate(element => element === document.querySelector('main'))).toBe(true)
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
  await expect(page.locator('[data-active="true"]')).toHaveAttribute('data-cell-id', selected!)
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', transform!)
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
  await expect(child).toHaveAttribute('data-status', 'done')
  for (const text of ['После приглашения', 'Продолжаем редактирование']) {
    await root(page).dblclick(); await page.getByRole('textbox').fill(text); await page.keyboard.press('Enter')
    await expect.poll(() => diskText(page)).toContain(text)
  }
  const context = await namedContext(browser)
  try {
    const guest = await context.newPage(); await guest.goto(invite); await ready(guest)
    await root(guest).dblclick(); await guest.getByRole('textbox').fill('Правка участника'); await guest.keyboard.press('Enter')
    await expect(root(page)).toHaveAttribute('data-text', 'Правка участника')
    await expect.poll(() => diskText(page)).toContain('Правка участника')
    await expect(page.locator('.file-save-state')).toHaveText('Сохранено')
    const writes = await page.evaluate(() => (window as unknown as { fileWrites: () => number }).fileWrites())
    await page.waitForTimeout(750)
    expect(await page.evaluate(() => (window as unknown as { fileWrites: () => number }).fileWrites())).toBe(writes)
    expect(errors).toEqual([])
    await expect(page).toHaveURL(ownerUrl)
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally { await context.close() }
})

for (const base of ['http://127.0.0.1:4173/', 'http://127.0.0.1:4183/decompose/']) {
  test(`old file URLs restore owners and guests on canonical paths at ${base}`, async ({ page, browser }) => {
    await page.goto(base); await ready(page); await installFilePicker(page); await openDisk(page)
    const localUrl = page.url(), localId = new URL(localUrl).pathname.split('/').at(-1)
    await page.goto(base + `?localFile=${localId}#bookmark`); await ready(page)
    await expect(page).toHaveURL(localUrl + '#bookmark')
    await expect(page.locator('.file-mode')).toHaveText('Файл на диске')
    await root(page).click(); await page.keyboard.press('Space')
    await expect.poll(async () => JSON.parse(await diskText(page)).nodes[0].status).toBe('done')
    await expect(page).toHaveURL(localUrl + '#bookmark')
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
    await page.context().setOffline(true)
    await page.goto(localUrl + '/'); await ready(page)
    await expect(page).toHaveURL(localUrl)
    expect(await page.evaluate(() => document.baseURI)).toBe(base)
    await expect(root(page)).toHaveAttribute('data-text', 'Файл схемы')
    await page.context().setOffline(false)
    const sharedUrl = await shareDisk(page), roomId = new URL(sharedUrl).pathname.split('/').at(-1)
    const legacyShared = base + `?fileSession=${roomId}`
    await page.goto(legacyShared); await ready(page)
    await expect(page).toHaveURL(localUrl)
    await expect(page.locator('.file-mode')).toHaveText('Файл на диске')
    const context = await namedContext(browser)
    try {
      const guest = await context.newPage(); await guest.goto(legacyShared); await ready(guest)
      await expect(guest).toHaveURL(sharedUrl)
      await expect(guest.locator('.file-mode')).toHaveText('По ссылке')
      await guest.goto(sharedUrl + '/'); await ready(guest)
      expect(await guest.evaluate(() => document.baseURI)).toBe(base)
      await expect(guest).toHaveURL(sharedUrl)
    } finally { await context.close() }
  })
}

test('legacy file placeholders keep the selection recovery screen on the canonical path', async ({ page }) => {
  await page.goto('/?localFile=1')
  await expect(page).toHaveURL(/\/file\/local\/1$/)
  await expect(page.getByRole('button', { name: 'Открыть файл на диске' })).toBeVisible()
})

test('owner keeps its local URL and resumes the same room and CRDT with and without guests', async ({ page, browser }) => {
  await page.goto('http://127.0.0.1:4183/decompose/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url()
  const url = await shareDisk(page)
  expect(await shareDisk(page)).toBe(url)
  const ids = await page.locator('[data-cell-id]').evaluateAll(elements => elements.map(e => e.getAttribute('data-cell-id')))
  // Перезагрузка последней вкладки не уничтожает комнату или её последнее состояние.
  await root(page).dblclick(); await page.getByRole('textbox').fill('До reload'); await page.keyboard.press('Enter')
  await expect.poll(() => diskText(page)).toContain('До reload')
  await page.reload(); await ready(page)
  expect(page.url()).toBe(localUrl)
  expect(await shareDisk(page)).toBe(url)
  await expect(root(page)).toHaveAttribute('data-text', 'До reload')
  expect(await page.locator('[data-cell-id]').evaluateAll(elements => elements.map(e => e.getAttribute('data-cell-id')))).toEqual(ids)
  const context = await namedContext(browser)
  try {
    const guest = await context.newPage(); await guest.goto(url); await ready(guest)
    await page.reload(); await ready(page)
    expect(page.url()).toBe(localUrl)
    await expect(guest.locator('.file-notice')).toHaveCount(0)
    await root(guest).dblclick(); await guest.getByRole('textbox').fill('После reload владельца'); await guest.keyboard.press('Enter')
    await expect.poll(() => diskText(page)).toContain('После reload владельца')
    await expect(page.locator('[data-cell-id]')).toHaveCount(2)
    await expect(page.locator('.file-mode')).toHaveText('Файл на диске')
  } finally { await context.close() }
})

test('a second tab is a guest on the shared URL and cannot open the same file for writing', async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url(), other = await page.context().newPage()
  try {
    await other.goto(localUrl)
    await expect(other.getByRole('alert')).toContainText('другой вкладке')
    await expect(other.locator('[data-cell-id]')).toHaveCount(0)
    // Повторный выбор через picker также находит тот же дескриптор и блокировку.
    await other.evaluate(async () => {
      Object.assign(window, { showOpenFilePicker: async () => [await (await navigator.storage.getDirectory()).getFileHandle('diagram-test.json')] })
    })
    await other.getByRole('button', { name: 'Открыть файл на диске' }).click()
    await expect(other.getByRole('alert')).toContainText('другой вкладке')
    const sharedUrl = await shareDisk(page)
    await other.goto(sharedUrl); await ready(other)
    await expect(other.locator('.file-mode')).toHaveText('По ссылке')
    await expect(other.locator('.document-title')).not.toContainText('Файл схемы')
    await other.setViewportSize({ width: 375, height: 720 })
    const title = (await other.locator('.document-title').boundingBox())!
    const arrow = (await other.locator('.file-menu-arrow').boundingBox())!
    expect(arrow.x + arrow.width).toBeLessThanOrEqual(title.x + title.width)
    await other.locator('.file-mode').click()
    await expect(other.getByRole('dialog', { name: 'Выбор схемы для редактирования', exact: true })).toBeVisible()
    await other.keyboard.press('Escape')
    await root(other).dblclick(); await other.getByRole('textbox').fill('Из второй вкладки'); await other.keyboard.press('Enter')
    await expect.poll(() => diskText(page)).toContain('Из второй вкладки')
    await page.locator('a.brand').click(); await ready(page)
    await other.goto(localUrl); await ready(other)
    await expect(other.locator('.file-mode')).toHaveText('Файл на диске')
  } finally { await other.close() }
})

test('restored file requests permission from a click without reopening the picker', async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const ownerUrl = page.url(), invitation = await shareDisk(page)
  await page.addInitScript(() => {
    let granted = false
    Object.assign(FileSystemFileHandle.prototype, {
      queryPermission: async () => granted ? 'granted' : 'prompt',
      requestPermission: async () => { granted = true; return 'granted' },
    })
  })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Продолжить работу с файлом' })).toBeVisible()
  await expect(page.locator('[data-cell-id]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Продолжить работу с файлом' }).click(); await ready(page)
  await expect(page).toHaveURL(ownerUrl)
  expect(await shareDisk(page)).toBe(invitation)
  await root(page).dblclick(); await page.getByRole('textbox').fill('После разрешения'); await page.keyboard.press('Enter')
  await expect.poll(() => diskText(page)).toContain('После разрешения')
})

test('resuming refuses external edits without overwriting the file', async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  await shareDisk(page)
  await page.evaluate(async contents => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('diagram-test.json')
    const writer = await handle.createWritable(); await writer.write(contents); await writer.close()
  }, JSON.stringify({ ...file, nodes: [{ ...file.nodes[0], text: 'Внешняя правка' }, file.nodes[1]] }))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('Автоматическое восстановление остановлено')
  expect(await diskText(page)).toContain('Внешняя правка')
  await expect(page.locator('[data-cell-id]')).toHaveCount(0)
})

for (const registered of [false, true]) test(`reload recovers an interrupted publication (${registered ? 'lost response' : 'unsent request'}) with the file ID`, async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url(), id = new URL(localUrl).pathname.split('/').at(-1)
  let secret = ''
  await page.route('**/api/file-sessions', async route => {
    expect(route.request().postDataJSON().id).toBe(id)
    secret = route.request().headers().authorization
    if (registered) expect((await route.fetch()).status()).toBe(201)
    await route.abort()
  })
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.getByRole('button', { name: 'Поделиться сессией' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  expect(page.url()).toBe(localUrl)
  expect(secret).toMatch(/^Bearer [\da-f-]{72}$/)
  await page.unroute('**/api/file-sessions')
  if (!registered) {
    await page.route('**/api/file-sessions', async route => {
      expect(route.request().postDataJSON().id).toBe(id)
      expect(route.request().headers().authorization).toBe(secret)
      await route.continue()
    })
  }
  await page.reload(); await ready(page)
  expect(page.url()).toBe(localUrl)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await shareDisk(page)).toBe(localUrl.replace('/file/local/', '/file/session/'))
  await root(page).dblclick(); await page.getByRole('textbox').fill('После повтора'); await page.keyboard.press('Enter')
  await expect.poll(() => diskText(page)).toContain('После повтора')
})

test('SPA distinguishes guest and local modes with the same ID and keeps the owner URL', async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url(), invite = await shareDisk(page)
  const other = await page.context().newPage()
  await other.goto(invite); await ready(other)
  await expect(other.locator('.file-mode')).toHaveText('По ссылке')
  await page.close()
  await other.evaluate(url => {
    history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate'))
  }, localUrl)
  await expect(other.locator('.file-mode')).toHaveText('Файл на диске')
  await ready(other)
  await expect(other).toHaveURL(localUrl)
  await other.evaluate(url => {
    history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate'))
  }, invite)
  await expect(other).toHaveURL(localUrl)
  await expect(other.locator('.file-mode')).toHaveText('Файл на диске')
  await expect(other.getByRole('alert')).toHaveCount(0)
  await root(other).dblclick(); await other.getByRole('textbox').fill('Вкладка стала владельцем'); await other.keyboard.press('Enter')
  await expect.poll(() => diskText(other)).toContain('Вкладка стала владельцем')
})

test('sharing again clears the informational notice without hiding guest warnings', async ({ page, browser }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const invite = await shareDisk(page)
  const context = await namedContext(browser)
  try {
    const guest = await context.newPage(); await guest.goto(invite); await ready(guest)
    await page.getByRole('button', { name: 'Схемы', exact: true }).click()
    await page.getByRole('button', { name: 'Поделиться сессией' }).click()
    await page.getByRole('button', { name: 'Завершить сессию' }).click()
    await expect(page.locator('.file-info')).toContainText('Работаешь с файлом на диске')
    await expect(guest.getByRole('alert')).toContainText('завершена')
    await expect(guest.getByRole('alert').getByRole('button', { name: 'Скачать копию' })).toBeVisible()
    expect(await shareDisk(page)).toBe(invite)
    await expect(page.locator('.file-info')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally { await context.close() }
})

test('the same invitation waits for its owner and reopens a fresh generation without stale guest state', async ({ page, browser }) => {
  await page.goto('http://127.0.0.1:4183/decompose/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url(), invite = await shareDisk(page)
  const context = await namedContext(browser)
  try {
    const stale = await context.newPage(); await stale.goto(invite); await ready(stale)
    await page.getByRole('button', { name: 'Схемы', exact: true }).click()
    await page.getByRole('button', { name: 'Поделиться сессией' }).click()
    await page.getByRole('button', { name: 'Завершить сессию' }).click()
    await expect(page.locator('.file-info')).toContainText('ссылка сохранена')
    await expect(stale.getByRole('alert')).toContainText('завершена')
    const waiting = await context.newPage(); await waiting.goto(invite)
    await expect(waiting.locator('.loading')).toContainText('Ожидаем владельца файла')
    await expect(waiting.locator('[data-cell-id]')).toHaveCount(0)
    await expect(waiting.getByRole('alert')).toHaveCount(0)
    // Пока комната закрыта, файл остаётся единственным источником нового поколения.
    await root(page).dblclick(); await page.getByRole('textbox').fill('Сохранено без участников'); await page.keyboard.press('Enter')
    await expect.poll(() => diskText(page)).toContain('Сохранено без участников')
    await page.reload(); await ready(page)
    expect(page.url()).toBe(localUrl)
    expect(await shareDisk(page)).toBe(invite)
    await expect(page.locator('.file-info')).toHaveCount(0)
    await ready(waiting)
    await expect(waiting).toHaveURL(invite)
    await expect(root(waiting)).toHaveAttribute('data-text', 'Сохранено без участников')
    await expect(root(stale)).toHaveAttribute('data-text', 'Файл схемы')
    await root(stale).dblclick(); await expect(stale.getByRole('textbox', { name: 'Текст клеточки' })).toHaveCount(0)
    await stale.getByRole('button', { name: 'Открыть актуальную схему' }).click(); await ready(stale)
    await expect(root(stale)).toHaveAttribute('data-text', 'Сохранено без участников')
    await expect(waiting.locator('.file-indicator')).toContainText('Сохраняет владелец')
    await expect(waiting.locator('.file-mode')).toHaveText('По ссылке')
    await expect(waiting.locator('.file-name')).toHaveText('diagram-test.json')
    await root(waiting).dblclick(); await waiting.getByRole('textbox').fill('После ожидания'); await waiting.keyboard.press('Enter')
    await expect.poll(() => diskText(page)).toContain('После ожидания')
    await page.locator('a.brand').click(); await ready(page)
    await page.evaluate(async () => {
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('diagram-test.json')
      Object.assign(window, { showOpenFilePicker: async () => [handle] })
    })
    await openDisk(page)
    expect(page.url()).toBe(localUrl)
    expect(await shareDisk(page)).toBe(invite)
    await expect(root(page)).toHaveAttribute('data-text', 'После ожидания')
  } finally { await context.close() }
})

test('explicitly picking an externally changed file replaces only the inactive generation and keeps both URLs', async ({ page }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url(), invite = await shareDisk(page)
  await page.evaluate(async contents => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('diagram-test.json')
    const writer = await handle.createWritable(); await writer.write(contents); await writer.close()
  }, JSON.stringify({ ...file, nodes: [{ ...file.nodes[0], text: 'Явно выбранная внешняя версия' }, file.nodes[1]] }))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('Автоматическое восстановление остановлено')
  await page.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('diagram-test.json')
    Object.assign(window, { showOpenFilePicker: async () => [handle] })
  })
  await page.getByRole('button', { name: 'Открыть файл на диске' }).click(); await ready(page)
  expect(page.url()).toBe(localUrl)
  expect(await shareDisk(page)).toBe(invite)
  await expect(root(page)).toHaveAttribute('data-text', 'Явно выбранная внешняя версия')
  await expect.poll(() => diskText(page)).toContain('Явно выбранная внешняя версия')
})

test('closing the owner tab and selecting the same file in a new tab preserves the invitation', async ({ page, browser }) => {
  await page.goto('/'); await ready(page); await installFilePicker(page); await openDisk(page)
  const localUrl = page.url(), invite = await shareDisk(page), ownerContext = page.context()
  const ids = await page.locator('[data-cell-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-cell-id')))
  const context = await namedContext(browser)
  let reopened: Page | undefined
  try {
    await page.close()
    const statusUrl = invite.replace('/file/session/', '/api/file-sessions/')
    await expect.poll(async () => (await (await context.request.get(statusUrl)).json()).name).toBe(null)
    const guest = await context.newPage(); await guest.goto(invite)
    await expect(guest.locator('.loading')).toContainText('Ожидаем владельца файла')
    await expect(guest.getByTestId('connection')).toHaveCount(0)
    reopened = await ownerContext.newPage(); await reopened.goto('/'); await ready(reopened)
    await reopened.evaluate(async () => {
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('diagram-test.json')
      Object.assign(window, { showOpenFilePicker: async () => [handle] })
    })
    await openDisk(reopened)
    expect(reopened.url()).toBe(localUrl)
    expect(await shareDisk(reopened)).toBe(invite)
    expect(await reopened.locator('[data-cell-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-cell-id')))).toEqual(ids)
    await ready(guest)
    await expect(guest.locator('.file-indicator')).toContainText('Сохраняет владелец')
    await root(guest).dblclick(); await guest.getByRole('textbox').fill('Работа после повторного выбора файла'); await guest.keyboard.press('Enter')
    await expect.poll(() => diskText(reopened!)).toContain('Работа после повторного выбора файла')
  } finally { await reopened?.close(); await context.close() }
})

test('missing files and cleared handle storage offer file selection without creating a server copy', async ({ page }) => {
  await page.goto('/'); await ready(page)
  const catalogBefore = await (await page.request.get('/api/diagrams')).json()
  await installFilePicker(page); await openDisk(page)
  await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('diagram-test.json'))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('Файл перемещён или удалён')
  await expect(page.getByRole('button', { name: 'Открыть файл на диске' })).toBeVisible()
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('decompose-file-handles-v1')
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error)
  }))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Открыть файл на диске' })).toBeVisible()
  await expect(page.locator('[data-cell-id]')).toHaveCount(0)
  const catalog = await (await page.request.get('/api/diagrams')).json()
  expect(catalog).toEqual(catalogBefore)
})
