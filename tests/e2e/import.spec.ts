import { testDiagram } from './fixtures'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, namedContext, type Page } from './fixtures'

const fixture = resolve('tests/fixtures/yed-tree.graphml')
const cell = (page: Page, text: string) => page.locator(`[data-text="${text}"]`)
const ready = async (page: Page) => {
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
  await expect(page.getByTestId('connection')).toHaveAttribute('data-connected', 'true')
}
async function picker(page: Page) {
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.getByRole('tablist', { name: 'Раздел каталога' }).getByRole('tab', { name: 'Файлы', exact: true }).click()
  await page.getByRole('button', { name: 'Новая схема из файла', exact: true }).click()
}
async function upload(page: Page, xml?: string) {
  await page.getByLabel('Файл схемы', { exact: true }).setInputFiles(xml === undefined ? fixture : {
    name: 'example.graphml', mimeType: 'application/xml', buffer: Buffer.from(xml),
  })
}

test('cancelling direct new or replacement file selection keeps the scheme and restores keyboard focus', async ({ page }) => {
  await page.goto(await testDiagram(page)); await ready(page)
  const before = await (await page.request.get('/api/diagrams')).json(), url = page.url()
  for (const open of [picker, replacementDialog]) {
    const chooser = page.waitForEvent('filechooser')
    await open(page); await chooser
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByLabel('Файл схемы', { exact: true }).dispatchEvent('cancel')
    await expect(page.locator('main')).toBeFocused()
    expect(page.url()).toBe(url)
    await expect(page.getByRole('alert')).toHaveCount(0)
  }
  expect(await (await page.request.get('/api/diagrams')).json()).toEqual(before)
})

test('imports all yEd nodes with semantic order and green status; reload, collaboration and undo work', async ({ page, browser }) => {
  await page.goto(await testDiagram(page))
  await ready(page)
  const previous = await page.locator('[data-cell-id]').evaluateAll(cells => cells.map(c => c.getAttribute('data-text')))
  const chooser = page.waitForEvent('filechooser')
  await picker(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await (await chooser).setFiles(fixture)
  await expect(page).toHaveURL(/\/diagram\/[0-9a-f-]{36}$/)
  await ready(page)
  const url = page.url()
  await expect(page.locator('[data-cell-id]')).toHaveCount(28)
  await expect(cell(page, 'Учебная схема')).toHaveAttribute('data-cell-id', 'root')
  await expect(page.locator('[data-status="done"]')).toHaveCount(1)
  await expect(cell(page, 'Узел 2')).toHaveAttribute('data-status', 'done')
  const parent = await cell(page, 'Узел 1').getAttribute('data-cell-id')
  const ordered = await page.locator(`[data-parent-id="${parent}"]`).evaluateAll(cells => cells
    .sort((a, b) => Number(a.getAttribute('data-order')) - Number(b.getAttribute('data-order')))
    .map(c => c.getAttribute('data-text')))
  expect(ordered).toEqual(['Узел 2', 'Узел 6', 'Узел 10', 'Узел 7', 'Узел 8', 'Узел 11'])
  const centers = await Promise.all(ordered.map(text => cell(page, text!).boundingBox()))
  expect(centers.every((box, i) => i === 0 || box!.y > centers[i - 1]!.y)).toBe(true)
  await expect(page.getByRole('button', { name: 'Отменить действие', exact: true })).toBeDisabled()
  await page.reload()
  await ready(page)
  await expect(page.locator('[data-cell-id]')).toHaveCount(28)
  const context = await namedContext(browser)
  try {
    const peer = await context.newPage()
    await peer.goto(url)
    await ready(peer)
    await expect(cell(peer, 'Узел 2')).toHaveAttribute('data-status', 'done')
    await cell(page, 'Учебная схема').dblclick()
    await page.getByRole('textbox', { name: 'Текст клеточки' }).fill('Импорт отредактирован')
    await page.keyboard.press('Enter')
    await expect(cell(peer, 'Импорт отредактирован')).toHaveCount(1)
    await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
    await expect(cell(peer, 'Учебная схема')).toHaveCount(1)
    await page.getByRole('button', { name: 'Повторить действие', exact: true }).click()
    await expect(cell(peer, 'Импорт отредактирован')).toHaveCount(1)
    await page.goto(await testDiagram(page))
    await ready(page)
    expect(await page.locator('[data-cell-id]').evaluateAll(cells => cells.map(c => c.getAttribute('data-text')))).toEqual(previous)
  } finally { await context.close() }
})

test('rejects unsupported and unsafe files without creating diagrams, and can select the same file again', async ({ page }) => {
  await page.goto(await testDiagram(page))
  await ready(page)
  const before = await (await page.request.get('/api/diagrams')).json()
  const xml = await readFile(fixture, 'utf8')
  await picker(page)
  const invalid = [
    '<not-xml',
    xml.replace('<graphml ', '<!DOCTYPE graphml [<!ENTITY private SYSTEM "file:///etc/passwd">]><graphml '),
    xml.replace('edgedefault="directed"', 'edgedefault="undirected"'),
    xml.replace('source="n0" target="n1"', 'source="absent" target="n1"'),
    xml.replace('source="n0" target="n1"', 'source="n2" target="n1"'),
    xml.replace('source="n0" target="n1"', 'source="n0" target="n2"'),
    xml.replace('id="n1"', 'id="n0"'),
    xml.replace('x="0"', 'x="NaN"'),
    xml.replace('width="245"', 'width="0"'),
    xml.replace(/<y:Geometry[^>]*\/>/, ''),
    xml.replace('<y:Shape type="rectangle"/>', '<y:NodeLabel>Вторая подпись</y:NodeLabel>'),
    xml.replace('<y:ShapeNode>', '<y:ImageNode>').replace('</y:ShapeNode>', '</y:ImageNode>'),
    xml.replace('</graphml>', '<graph id="extra" edgedefault="directed"/></graphml>'),
    xml.replace('<node id="n0">', '<node id="n0"><graph id="nested" edgedefault="directed"/>'),
    xml.replace('</graph>', '<hyperedge id="h"/></graph>'),
    xml.replace('</graph>', '<node id="extra"/>'.repeat(973) + '</graph>'),
    ' '.repeat(5 * 1024 * 1024 + 1),
    xml.replace('Учебная схема', 'я'.repeat(530000)),
  ]
  for (const content of invalid) {
    await upload(page, content)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(page.url()).toBe(await testDiagram(page))
  }
  expect(await (await page.request.get('/api/diagrams')).json()).toEqual(before)
  await upload(page)
  await expect(page).toHaveURL(/\/diagram\/[0-9a-f-]{36}$/)
  await ready(page)
})

test('node and edge XML order never override geometry; equal centers use lexical source IDs', async ({ page }) => {
  await page.goto(await testDiagram(page))
  await ready(page)
  let xml = await readFile(fixture, 'utf8')
  const nodes = xml.match(/<node\b[\s\S]*?<\/node>/g)!.reverse()
  const edges = xml.match(/<edge\b[^>]*\/>/g)!.reverse()
  xml = xml.replace(/<node\b[\s\S]*?<\/node>/g, () => nodes.shift()!)
    .replace(/<edge\b[^>]*\/>/g, () => edges.shift()!)
  // Совпадающие центры: n10 < n2 < n6, независимо от числового суффикса и XML-порядка.
  xml = xml.replace(/<node id="n(?:2|6|10)">[\s\S]*?<\/node>/g, block =>
    block.replace(/<y:Geometry[^>]*\/>/, '<y:Geometry x="571" y="0" width="245" height="57"/>'))
  await picker(page)
  await upload(page, xml)
  await expect(page).toHaveURL(/\/diagram\/[0-9a-f-]{36}$/)
  await ready(page)
  const parent = await cell(page, 'Узел 1').getAttribute('data-cell-id')
  const ordered = await page.locator(`[data-parent-id="${parent}"]`).evaluateAll(cells => cells
    .sort((a, b) => Number(a.getAttribute('data-order')) - Number(b.getAttribute('data-order')))
    .map(c => c.getAttribute('data-text')))
  expect(ordered).toEqual(['Узел 10', 'Узел 2', 'Узел 6', 'Узел 7', 'Узел 8', 'Узел 11'])
})

test('reports server failure, resets file selection and prevents duplicate submissions while importing', async ({ page }) => {
  await page.goto(await testDiagram(page))
  await ready(page)
  await picker(page)
  await page.route('**/api/diagrams/import', route => route.fulfill({ status: 503, json: { error: 'Сервер временно недоступен' } }))
  await upload(page)
  await expect(page.getByRole('alert')).toContainText('Сервер временно недоступен')
  expect(page.url()).toBe(await testDiagram(page))
  await page.unroute('**/api/diagrams/import')
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let requests = 0
  await page.route('**/api/diagrams/import', async route => {
    requests++
    await barrier
    await route.continue()
  })
  try {
    await upload(page)
    await expect.poll(() => requests).toBe(1)
    await expect(page.getByRole('status').filter({ hasText: 'Загружаем файл…' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await upload(page)
    release()
    await expect(page).toHaveURL(/\/diagram\/[0-9a-f-]{36}$/)
    await ready(page)
    expect(requests).toBe(1)
  } finally { release() }
})

test('accepts GenericNode and namespaces, treats labels as plain text and ignores transparent or gradient green', async ({ page }) => {
  await page.goto(await testDiagram(page))
  await ready(page)
  const xml = (await readFile(fixture, 'utf8'))
    .replaceAll('ShapeNode', 'GenericNode').replaceAll('xmlns:y=', 'xmlns:paint=').replaceAll('y:', 'paint:')
    .replace('Учебная схема', '&lt;b&gt;Обычный\nтекст&lt;/b&gt;')
    .replace('color="#99CC00" transparent="false"', 'color="#99CC00" transparent="true"')
    .replace('color="#FFCC00" transparent="false"', 'color="#00FF00" color2="#FF0000" transparent="false"')
  await picker(page)
  await upload(page, xml)
  await expect(page).toHaveURL(/\/diagram\/[0-9a-f-]{36}$/)
  await ready(page)
  await expect(page.locator('[data-cell-id="root"]')).toHaveAttribute('data-text', '<b>Обычный\nтекст</b>')
  await expect(page.locator('[data-status="done"]')).toHaveCount(0)
  await expect(page.locator('[data-cell-id="root"] b')).toHaveCount(0)
})

test('guest can cancel import, then introduce themselves and import exactly once; offline import is disabled', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(await testDiagram(page))
    await ready(page)
    const before = await (await page.request.get('/api/diagrams')).json()
    await picker(page)
    await upload(page)
    await expect(page.getByRole('dialog', { name: 'Представься' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('main')).toBeFocused()
    expect(await (await page.request.get('/api/diagrams')).json()).toEqual(before)
    await upload(page)
    await page.getByRole('textbox', { name: 'Имя', exact: true }).fill('Импортёр')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/diagram\/[0-9a-f-]{36}$/)
    await ready(page)
    expect(await (await page.request.get('/api/diagrams')).json()).toHaveLength(before.length + 1)
    await context.setOffline(true)
    await expect(page.getByTestId('connection')).toHaveAttribute('data-connected', 'false')
    await page.getByRole('button', { name: 'Схемы', exact: true }).click()
    await page.getByRole('tablist', { name: 'Раздел каталога' }).getByRole('tab', { name: 'Файлы', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Новая схема из файла', exact: true })).toBeDisabled()
  } finally { await context.close() }
})

async function replacementDialog(page: Page) {
  await page.getByRole('button', { name: 'Схемы', exact: true }).click()
  await page.getByRole('button', { name: 'Заменить из файла', exact: true }).click()
}

test('replaces a tracker tree directly from GraphML, keeps its URL and binding and synchronizes peers', async ({ page, browser }) => {
  await page.goto('/tracker/GRAPHML-101'); await ready(page)
  const url = page.url(), id = await page.locator('main').getAttribute('data-diagram-id')
  const catalog = await (await page.request.get('/api/diagrams')).json()
  const context = await namedContext(browser)
  try {
    const peer = await context.newPage(); await peer.goto(url); await ready(peer)
    const chooser = page.waitForEvent('filechooser')
    await replacementDialog(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await (await chooser).setFiles(fixture)
    const confirm = page.getByRole('button', { name: 'Заменить схему', exact: true })
    await expect(confirm).toBeVisible()
    await expect(page.locator('[data-cell-id="root"]')).toHaveAttribute('data-text', 'GRAPHML-101')
    await confirm.click()
    for (const client of [page, peer]) {
      await expect(client.locator('[data-cell-id]')).toHaveCount(28)
      await ready(client)
      await expect(client).toHaveURL(url)
      await expect(client.locator('main')).toHaveAttribute('data-diagram-id', id!)
      await expect(cell(client, 'Учебная схема')).toHaveAttribute('data-cell-id', 'root')
      await expect(cell(client, 'Узел 2')).toHaveAttribute('data-status', 'done')
      await expect(client.getByRole('button', { name: 'Отменить действие', exact: true })).toBeDisabled()
      await expect(cell(client, 'Учебная схема').locator('.cell-text')).toHaveCSS('text-align', 'left')
    }
    const parent = await cell(page, 'Узел 1').getAttribute('data-cell-id')
    expect(await page.locator(`[data-parent-id="${parent}"]`).evaluateAll(cells => cells
      .sort((a, b) => Number(a.getAttribute('data-order')) - Number(b.getAttribute('data-order')))
      .map(c => c.getAttribute('data-text')))).toEqual(['Узел 2', 'Узел 6', 'Узел 10', 'Узел 7', 'Узел 8', 'Узел 11'])
    expect(await (await page.request.get('/api/tracker/GRAPHML-101')).json()).toMatchObject({ id, trackerKey: 'GRAPHML-101', title: 'Учебная схема' })
    expect(await (await page.request.get('/api/diagrams')).json()).toEqual(catalog)
    const search = await (await page.request.get('/api/tracker?q=Учебная')).json()
    expect(search.items).toEqual(expect.arrayContaining([expect.objectContaining({ id, trackerKey: 'GRAPHML-101' })]))
    await page.reload(); await ready(page)
    await expect(page).toHaveURL(url)
    await expect(cell(page, 'Узел 2')).toHaveAttribute('data-status', 'done')
  } finally { await context.close() }
})

test('invalid GraphML, cancellation and server errors do not replace the selected tree; retry succeeds', async ({ page }) => {
  const { id } = await (await page.request.post('/api/diagrams', { data: { title: 'До импорта GraphML' } })).json()
  await page.goto(`/diagram/${id}`); await ready(page)
  const url = page.url(), xml = await readFile(fixture, 'utf8')
  await replacementDialog(page)
  const input = page.getByLabel('Файл схемы', { exact: true })
  await input.setInputFiles({ name: 'bad.graphml', mimeType: 'application/xml', buffer: Buffer.from('<not-xml') })
  await expect(page.getByRole('alert')).toContainText('Некорректный XML')
  await expect(cell(page, 'До импорта GraphML')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Заменить схему', exact: true })).toHaveCount(0)
  await input.setInputFiles(fixture)
  await expect(page.getByRole('button', { name: 'Заменить схему', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(cell(page, 'До импорта GraphML')).toBeVisible()
  expect(await (await page.request.get(`/api/diagrams/${id}/generation`)).json()).toEqual({ generation: 0 })
  await replacementDialog(page)
  await input.setInputFiles({ name: 'task.GRAPHML', mimeType: 'application/xml', buffer: Buffer.from(xml) })
  await page.route(`**/api/diagrams/${id}/replace`, route => route.fulfill({ status: 503, json: { error: 'Замена временно недоступна' } }))
  await page.getByRole('button', { name: 'Заменить схему', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Замена временно недоступна')
  await expect(cell(page, 'До импорта GraphML')).toBeVisible()
  await page.unroute(`**/api/diagrams/${id}/replace`)
  await page.getByRole('button', { name: 'Заменить схему', exact: true }).click()
  await expect(cell(page, 'Учебная схема')).toBeVisible()
  await expect(page).toHaveURL(url)
  expect(await (await page.request.get(`/api/diagrams/${id}/generation`)).json()).toEqual({ generation: 1 })
})

test('the file dialog can also create a new scheme from GraphML without changing the tracker', async ({ page }) => {
  await page.goto('/tracker/GRAPHML-102'); await ready(page)
  const original = await (await page.request.get('/api/tracker/GRAPHML-102')).json()
  await picker(page)
  await page.getByLabel('Файл схемы', { exact: true }).setInputFiles(fixture)
  await expect(page).toHaveURL(/\/diagram\/[0-9a-f-]{36}$/)
  await ready(page)
  await expect(cell(page, 'Учебная схема')).toHaveAttribute('data-cell-id', 'root')
  expect(await (await page.request.get('/api/tracker/GRAPHML-102')).json()).toEqual(original)
})
