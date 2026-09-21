import { expect, test, type Page } from './fixtures'
import { testDiagram } from './fixtures'

const cell = (page: Page, id: string) => page.locator(`[data-cell-id="${id}"]`)

async function open(page: Page) {
  await page.goto(await testDiagram(page))
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
}

async function create(page: Page, key: string, text: string) {
  await page.keyboard.press(key)
  await page.getByRole('textbox').fill(text)
  await page.keyboard.press('Control+Enter')
  const active = page.locator('[data-cell-id][data-active="true"]')
  await expect(active).toHaveAttribute('data-text', text)
  return (await active.getAttribute('data-cell-id'))!
}

test('copy, cut and paste operate on complete subtrees with fresh identities', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page)
  await cell(page, 'root').click()
  const branch = await create(page, 'Tab', 'Ветка')
  const child = await create(page, 'Tab', 'Деталь')
  await page.keyboard.press('Space')
  await cell(page, branch).click()
  const target = await create(page, 'Enter', 'Назначение')

  await cell(page, branch).click()
  await page.keyboard.press('Control+c')
  await expect(page.locator('#keyboard-status')).toContainText('Поддерево скопировано')
  await cell(page, target).click()
  await page.keyboard.press('Control+v')
  const firstCopy = page.locator(`[data-parent-id="${target}"][data-text="Ветка"]`)
  await expect(firstCopy).toHaveCount(1)
  const firstCopyId = (await firstCopy.getAttribute('data-cell-id'))!
  expect(firstCopyId).not.toBe(branch)
  await expect(page.locator(`[data-parent-id="${firstCopyId}"][data-text="Деталь"]`)).toHaveAttribute('data-status', 'done')

  await page.keyboard.press('Control+z')
  await expect(firstCopy).toHaveCount(0)
  await page.keyboard.press('Control+Shift+z')
  await expect(firstCopy).toHaveCount(1)

  await cell(page, branch).click()
  await page.keyboard.press('Control+x')
  await expect(cell(page, branch)).toHaveCount(0)
  await expect(cell(page, child)).toHaveCount(0)
  await cell(page, target).click()
  await page.keyboard.press('Control+v')
  const copies = page.locator(`[data-parent-id="${target}"][data-text="Ветка"]`)
  await expect(copies).toHaveCount(2)
  const cutCopy = page.locator('[data-cell-id][data-active="true"]')
  await expect(cutCopy).toHaveAttribute('data-parent-id', target)
  await expect(cutCopy).toHaveAttribute('data-text', 'Ветка')
  const cutCopyId = (await cutCopy.getAttribute('data-cell-id'))!
  expect(cutCopyId).not.toBe(branch)

  await cell(page, 'root').click()
  await page.keyboard.press('Control+x')
  await expect(cell(page, 'root')).toHaveCount(1)
})

test('plain text is not converted to a card and editor clipboard remains native', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page)
  await cell(page, 'root').click()
  const before = await page.locator('[data-cell-id]').count()
  await page.evaluate(() => navigator.clipboard.writeText('Обычный текст'))
  await page.keyboard.press('Control+v')
  await expect(page.locator('[data-cell-id]')).toHaveCount(before)

  const card = await create(page, 'Tab', 'До ')
  await page.keyboard.press('F2')
  const editor = page.getByRole('textbox')
  await editor.press('End')
  await page.keyboard.press('Control+v')
  await expect(editor).toHaveValue('До Обычный текст')
  await page.keyboard.press('Control+Enter')
  await expect(cell(page, card)).toHaveAttribute('data-text', 'До Обычный текст')
})

test('copied subtree can be pasted into another diagram', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page)
  await cell(page, 'root').click()
  const branch = await create(page, 'Tab', 'Между схемами')
  await create(page, 'Tab', 'Вложенная карточка')
  await cell(page, branch).click()
  await page.keyboard.press('Control+c')
  await expect(page.locator('#keyboard-status')).toContainText('Поддерево скопировано')

  const response = await page.request.post('/api/diagrams', { data: { title: 'Вторая схема' } })
  const { id } = await response.json()
  await page.goto(`/diagram/${id}`)
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
  await cell(page, 'root').click()
  await page.keyboard.press('Control+v')
  const copy = page.locator('[data-parent-id="root"][data-text="Между схемами"]')
  await expect(copy).toHaveCount(1)
  await expect(page.locator(`[data-parent-id="${await copy.getAttribute('data-cell-id')}"][data-text="Вложенная карточка"]`)).toHaveCount(1)
})
