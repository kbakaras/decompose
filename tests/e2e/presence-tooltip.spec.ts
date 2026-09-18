import { expect, test, type Page } from './fixtures'

test('selection tooltips list participants, deduplicate tabs and follow presence changes', async ({ page, browser }) => {
  const response = await page.request.post('/api/diagrams', { data: { title: 'Подсказки выделения' } })
  expect(response.ok()).toBe(true)
  const { id } = await response.json()
  const url = `/?diagram=${id}`
  const root = (client: Page) => client.locator('[data-cell-id="root"]')
  const open = async (client: Page) => {
    await client.goto(url)
    await expect(client.locator('main')).toHaveAttribute('data-ready', 'true')
    await expect(client.getByTestId('connection')).toHaveAttribute('data-connected', 'true')
  }
  await open(page)
  await root(page).click()
  await page.keyboard.press('Tab')
  await page.getByRole('textbox').fill('Другая карточка')
  await page.keyboard.press('Enter')
  const childId = await page.locator('[data-active="true"]').getAttribute('data-cell-id')
  const child = (client: Page) => client.locator(`[data-cell-id="${childId}"]`)
  await expect(root(page)).not.toHaveAttribute('title')
  await expect(child(page)).not.toHaveAttribute('title')

  const annaContext = await browser.newContext()
  const borisContext = await browser.newContext()
  try {
    await annaContext.addInitScript(() => localStorage.setItem('decompose:participant-name:v1', 'Анна'))
    await borisContext.addInitScript(() => localStorage.setItem('decompose:participant-name:v1', 'Борис'))
    const anna = await annaContext.newPage()
    await open(anna)
    await expect(root(page)).toHaveClass(/cell-with-presence/)
    await expect(root(page)).toHaveAttribute('title', 'Анна')

    const annaTab = await annaContext.newPage()
    await open(annaTab)
    // Другая собственная вкладка по-прежнему показывает выделение и имя.
    await expect(root(anna)).toHaveAttribute('title', 'Анна')
    await expect(root(page)).toHaveAttribute('title', 'Анна')

    const boris = await borisContext.newPage()
    await open(boris)
    await expect(root(page)).toHaveAttribute('title', 'Анна, Борис')
    await child(boris).click()
    await expect(root(page)).toHaveAttribute('title', 'Анна')
    await expect(child(page)).toHaveAttribute('title', 'Борис')
    await expect(child(page)).toHaveAttribute('data-active', 'true')
    await expect(child(page)).toHaveCSS('outline-style', 'dashed')
    await expect(child(page)).toHaveCSS('outline-offset', '7px')
    await expect(child(page)).toHaveCSS('box-shadow', /rgb\(168, 107, 8\) 0px 0px 0px 2px/)

    await anna.getByRole('button', { name: 'Изменить имя' }).click()
    await anna.getByLabel('Имя', { exact: true }).fill('Анна Иванова')
    await anna.keyboard.press('Enter')
    await expect(root(page)).toHaveAttribute('title', 'Анна Иванова')
    await anna.close()
    await expect(root(page)).toHaveAttribute('title', 'Анна Иванова')
    await annaTab.close()
    await expect(root(page)).not.toHaveClass(/cell-with-presence/)
    await expect(root(page)).not.toHaveAttribute('title')
    await boris.close()
    await expect(child(page)).not.toHaveAttribute('title')
  } finally {
    await annaContext.close()
    await borisContext.close()
  }
})
