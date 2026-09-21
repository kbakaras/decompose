import { testDiagram } from './fixtures'
import { test, expect, namedContext, type Page } from './fixtures'

const root = (page: Page) => page.locator('[data-cell-id="root"]')
const ready = (page: Page) => expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
const picker = (page: Page) => page.getByRole('button', { name: 'Схемы', exact: true }).click()
async function create(page: Page, title = 'Удаляемая схема', base = 'http://127.0.0.1:4173/') {
  const { id } = await (await page.request.post('/api/diagrams', { data: { title } })).json()
  await page.goto(`${base}?diagram=${id}`); await ready(page); return id as string
}
async function deleteDialog(page: Page) {
  await picker(page); await page.getByRole('button', { name: 'Удалить схему' }).click()
}
async function transferDialog(page: Page) {
  await picker(page); await page.getByRole('button', { name: 'Перенести в файл', exact: true }).click()
}

test('scheme actions live in the picker, cancellation restores keyboard focus', async ({ page }) => {
  await page.goto(await testDiagram(page)); await ready(page)
  await page.getByRole('button', { name: 'Действия с клеточкой' }).click()
  await expect(page.getByRole('button', { name: 'Заменить из файла' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Сохранить в файл' })).toHaveCount(0)
  await picker(page)
  await expect(page.getByRole('button', { name: 'Удалить схему' })).toBeEnabled()
  await page.getByRole('tablist', { name: 'Раздел каталога' }).getByRole('tab', { name: 'Задачи' }).click()
  await expect(page.getByRole('button', { name: 'Заменить из файла' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Перенести в файл' })).toBeEnabled()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Сохранить в файл' }).click()
  await download
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(page.locator('main')).toBeFocused()
})

test('deletion confirmation uses the application dialog and destructive button styles', async ({ page }) => {
  await page.goto(await testDiagram(page)); await ready(page)
  await picker(page)
  const pickerDelete = page.getByRole('button', { name: 'Удалить схему', exact: true })
  const expected = await pickerDelete.evaluate(element => {
    const style = getComputedStyle(element)
    return { fontFamily: style.fontFamily, fontSize: style.fontSize, borderRadius: style.borderRadius, color: style.color }
  })
  await pickerDelete.click()
  const dialog = page.getByRole('dialog', { name: 'Удалить схему', exact: true })
  const confirm = dialog.getByRole('button', { name: 'Удалить для всех', exact: true })
  await expect(dialog).toHaveClass(/confirmation-dialog/)
  await expect(dialog.getByRole('heading', { name: 'Удалить схему', exact: true })).toHaveCSS('font-size', '20px')
  await expect(dialog.getByText('«Тестовая схема»', { exact: true })).toHaveCSS('font-size', '14px')
  await expect(dialog).toContainText('Нет ни корзины, ни возможности отменить удаление.')
  expect(await dialog.textContent()).not.toContain(';')
  await expect(dialog.locator('.dialog-actions')).toHaveCSS('justify-content', 'flex-end')
  await expect(confirm).toHaveCSS('font-family', expected.fontFamily)
  await expect(confirm).toHaveCSS('font-size', expected.fontSize)
  await expect(confirm).toHaveCSS('border-radius', expected.borderRadius)
  await expect(confirm).toHaveCSS('color', expected.color)
  await expect(dialog.getByRole('button').allTextContents()).resolves.toEqual(['Удалить для всех', 'Отмена'])
})

test('deletion freezes peers, clears document caches and prevents offline resurrection', async ({ page, browser }) => {
  const id = await create(page)
  const onlineContext = await namedContext(browser), offlineContext = await namedContext(browser)
  try {
    const peer = await onlineContext.newPage(), offline = await offlineContext.newPage()
    for (const client of [peer, offline]) { await client.goto(page.url()); await ready(client) }
    await offlineContext.setOffline(true)
    await root(offline).dblclick(); await offline.getByRole('textbox').fill('Offline: сохранить копией'); await offline.keyboard.press('Enter')
    await root(peer).dblclick(); await peer.getByRole('textbox').fill('Draft другой вкладки')
    await deleteDialog(page)
    await page.getByRole('button', { name: 'Отмена', exact: true }).click()
    expect((await page.request.get(`/api/diagrams/${id}`)).status()).toBe(200)
    await deleteDialog(page); await page.getByRole('button', { name: 'Удалить для всех' }).click()
    await expect(page.getByRole('dialog', { name: 'Выбор схемы для редактирования', exact: true })).toBeVisible()
    expect((await page.request.get(`/api/diagrams/${id}`)).status()).toBe(410)
    await expect(peer.getByRole('alert')).toContainText('Схема удалена')
    await expect(root(peer)).toHaveAttribute('data-text', 'Draft другой вкладки')
    await picker(peer)
    await expect(peer.getByRole('tab', { name: 'Схемы', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(peer.getByRole('tab', { name: 'Схемы', exact: true })).toBeFocused()
    await peer.keyboard.press('Escape')
    await root(peer).dblclick(); await expect(peer.getByRole('textbox', { name: 'Текст клеточки' })).toHaveCount(0)
    await expect.poll(() => peer.evaluate(async id => (await indexedDB.databases()).filter(db => db.name?.startsWith(`decompose:${id}`)).length, id)).toBe(0)
    await offlineContext.setOffline(false)
    await expect(offline.getByRole('alert')).toContainText('Схема удалена')
    await expect(root(offline)).toHaveAttribute('data-text', 'Offline: сохранить копией')
    const download = offline.waitForEvent('download'); await offline.getByRole('button', { name: 'Скачать копию' }).click(); await download
    expect((await page.request.get(`/api/diagrams/${id}`)).status()).toBe(410)
    await peer.reload(); await expect(peer.getByRole('alert')).toContainText('Схема удалена')
  } finally { await onlineContext.close(); await offlineContext.close() }
})

test('a deleted tracker link requires explicit recreation and does not reconnect the old ID', async ({ page }) => {
  await page.goto('/tracker/DELETE-920'); await ready(page)
  const oldId = await page.locator('main').getAttribute('data-diagram-id')
  await deleteDialog(page); await page.getByRole('button', { name: 'Удалить для всех' }).click()
  await expect(page.getByRole('dialog', { name: 'Выбор схемы для редактирования', exact: true })).toBeVisible()
  await page.goto('/tracker/DELETE-920')
  await expect(page.getByRole('button', { name: 'Создать новое дерево' })).toBeVisible()
  expect((await page.request.get('/api/tracker/DELETE-920')).status()).toBe(410)
  await page.getByRole('button', { name: 'Создать новое дерево' }).click(); await ready(page)
  await expect(root(page)).toHaveAttribute('data-text', 'DELETE-920')
  expect(await page.locator('main').getAttribute('data-diagram-id')).not.toBe(oldId)
})

// Реальная запись браузера в тестовый OPFS, только системный picker подменён.
async function savePicker(page: Page, fail = false, denied = false) {
  await page.evaluate(async ({ fail, denied }) => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('transfer.json', { create: true })
    const writer = await handle.createWritable(); await writer.write('Исходный файл'); await writer.close()
    const createWritable = handle.createWritable.bind(handle)
    Object.assign(handle, {
      queryPermission: async () => denied ? 'denied' : 'granted', requestPermission: async () => denied ? 'denied' : 'granted',
      createWritable: async () => {
        if (fail) throw new Error('Диск недоступен')
        return createWritable()
      },
    })
    Object.assign(window, { showSaveFilePicker: async (options: unknown) => { Object.assign(window, { saveOptions: options }); return handle } })
  }, { fail, denied })
}
async function diskText(page: Page) {
  return page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('transfer.json')).getFile()).text())
}

test('transfer under a prefix includes remote drafts, reconciles a lost commit response and continues only in the file', async ({ page, browser }) => {
  const id = await create(page, 'Исходная схема', 'http://127.0.0.1:4183/decompose/')
  await savePicker(page)
  const context = await namedContext(browser)
  try {
    const peer = await context.newPage(); await peer.goto(page.url()); await ready(peer)
    await root(peer).dblclick(); await peer.getByRole('textbox').fill('Последний текст участника')
    await page.route('**/file-transfer/*/commit', async route => { await route.fetch(); await route.abort() })
    await transferDialog(page)
    await page.getByRole('button', { name: 'Перенести в файл' }).click()
    await expect(page).toHaveURL(/\/decompose\/file\/local\/[\da-f-]{36}/)
    expect(await page.evaluate(() => (window as unknown as { saveOptions: unknown }).saveOptions)).toMatchObject({
      suggestedName: 'Исходная схема.deco', types: [{ accept: { 'application/json': ['.deco'] } }],
    })
    await expect(page.locator('.file-indicator')).toContainText('Файл на диске')
    await expect(page.locator('.file-name')).toHaveText('transfer.json')
    await expect(root(page)).toHaveAttribute('data-text', 'Последний текст участника')
    expect(JSON.parse(await diskText(page)).nodes[0].text).toBe('Последний текст участника')
    expect((await page.request.get(`/api/diagrams/${id}`)).status()).toBe(410)
    await expect(peer.getByRole('alert')).toContainText('Схема удалена')
    await root(page).dblclick(); await page.getByRole('textbox').fill('Теперь только в файле'); await page.keyboard.press('Enter')
    await expect.poll(() => diskText(page)).toContain('Теперь только в файле')
    await expect.poll(() => page.evaluate(async id => (await indexedDB.databases()).filter(db => db.name?.startsWith(`decompose:${id}`)).length, id)).toBe(0)
    expect(JSON.stringify(await (await page.request.get('/api/diagrams')).json())).not.toContain(id)
  } finally { await context.close() }
})

test('a cancelled picker or failed write leaves the system diagram editable and does not delete it', async ({ page }) => {
  const id = await create(page)
  await page.evaluate(() => Object.assign(window, { showSaveFilePicker: async () => { throw new DOMException('Отмена', 'AbortError') } }))
  await transferDialog(page)
  await page.getByRole('button', { name: 'Перенести в файл' }).click()
  await expect(page.getByRole('button', { name: 'Перенести в файл' })).toBeEnabled()
  expect((await page.request.get(`/api/diagrams/${id}`)).status()).toBe(200)
  await savePicker(page, false, true)
  await page.getByRole('button', { name: 'Перенести в файл' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Нет разрешения')
  expect((await page.request.get(`/api/diagrams/${id}`)).status()).toBe(200)
  await savePicker(page, true)
  await page.getByRole('button', { name: 'Перенести в файл' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Диск недоступен')
  expect((await page.request.get(`/api/diagrams/${id}`)).status()).toBe(200)
  expect(await diskText(page)).toBe('Исходный файл')
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(page.locator('.file-notice')).toHaveCount(0)
  await root(page).dblclick(); await page.getByRole('textbox').fill('Продолжаем'); await page.keyboard.press('Enter')
  await expect(root(page)).toHaveAttribute('data-text', 'Продолжаем')
})

test('leaving the diagram while the native picker is pending cancels the transfer', async ({ page }) => {
  await page.goto(await testDiagram(page)); await ready(page)
  const { id } = await (await page.request.post('/api/diagrams', { data: { title: 'Не удалять после ухода' } })).json()
  await page.evaluate(id => { history.pushState(null, '', `/diagram/${id}`); window.dispatchEvent(new PopStateEvent('popstate')) }, id)
  await expect(root(page)).toHaveAttribute('data-text', 'Не удалять после ухода')
  await savePicker(page)
  await page.evaluate(() => {
    const original = (window as unknown as { showSaveFilePicker: () => Promise<unknown> }).showSaveFilePicker
    Object.assign(window, { showSaveFilePicker: () => new Promise(resolve => {
      Object.assign(window, { resumeSavePicker: async () => resolve(await original()) })
    }) })
  })
  const preparations: string[] = []
  page.on('request', request => { if (request.url().endsWith('/file-transfer')) preparations.push(request.url()) })
  await transferDialog(page)
  await page.getByRole('button', { name: 'Перенести в файл' }).click()
  await page.goBack(); await ready(page)
  await expect(page.locator('main')).toHaveAttribute('data-diagram-id', (await testDiagram(page)).split('/').pop()!)
  await page.evaluate(() => (window as unknown as { resumeSavePicker: () => Promise<void> }).resumeSavePicker())
  expect((await page.request.get(`/api/diagrams/${id}`)).status()).toBe(200)
  expect(preparations).toEqual([])
})
