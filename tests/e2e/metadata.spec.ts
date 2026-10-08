import { expect, test, testDiagram } from './fixtures'

async function ready(page: import('@playwright/test').Page) {
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
  await expect(page.getByTestId('connection')).toHaveAttribute('data-connected', 'true')
}

test('F4 shows update metadata and the global recency slider highlights recent cards', async ({ page }) => {
  await page.goto(await testDiagram(page))
  await ready(page)
  const root = page.locator('[data-cell-id="root"]')

  await page.keyboard.press('F4')
  const dialog = page.getByRole('dialog', { name: 'Параметры карточки' })
  await expect(dialog.getByText('Нет данных')).toHaveCount(2)
  await dialog.getByRole('button', { name: 'Закрыть' }).click()

  await page.keyboard.press('F2')
  await page.getByRole('textbox', { name: 'Текст клеточки' }).fill('Карточка с метаданными')
  await page.keyboard.press('Enter')
  await page.keyboard.press('F4')
  await expect(dialog.getByText('Участник теста', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Нет данных')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Закрыть' }).click()

  const menuButton = page.getByRole('button', { name: 'Действия с клеточкой', exact: true })
  await menuButton.click()
  const slider = page.getByRole('slider', { name: 'Давность выделяемых изменений' })
  await expect(slider).toHaveValue('11')
  await expect(root).toHaveAttribute('data-recent', 'false')
  await expect(page.locator('.recency-band-done')).toHaveCSS('background-image', /rgb\(199, 232, 167\).*rgb\(230, 243, 215\)/)
  await expect(page.locator('.recency-band-open')).toHaveCSS('background-image', /rgb\(255, 227, 161\).*rgb\(255, 241, 207\)/)
  const scaleGeometry = await page.locator('.recency-scale').evaluate(element => {
    const setting = element.closest('.recency-setting')!
    const previous = setting.previousElementSibling!.getBoundingClientRect()
    const label = setting.querySelector('.recency-label')!.getBoundingClientRect()
    const done = element.querySelector('.recency-band-done')!.getBoundingClientRect()
    const open = element.querySelector('.recency-band-open')!.getBoundingClientRect()
    const input = element.querySelector('input')!.getBoundingClientRect()
    const endpoints = setting.querySelector('.recency-endpoints')!.getBoundingClientRect()
    return {
      bandCount: element.querySelectorAll('.recency-band').length,
      previousGap: label.top - previous.bottom,
      labelGap: done.top - label.bottom,
      doneHeight: done.height,
      openHeight: open.height,
      gap: open.top - done.bottom,
      inputHeight: input.height,
      inputPosition: getComputedStyle(element.querySelector('input')!).position,
      endpointsGap: endpoints.top - open.bottom,
    }
  })
  expect(scaleGeometry).toEqual({
    bandCount: 2, previousGap: 14, labelGap: 10,
    doneHeight: 7, openHeight: 7, gap: 0,
    inputHeight: 28, inputPosition: 'absolute', endpointsGap: 12,
  })
  await slider.fill('10')
  await expect(slider).toHaveAttribute('aria-valuetext', 'Изменения за последний день')
  await expect(root).toHaveAttribute('data-recent', 'true')
  await expect(root).toHaveCSS('background-color', 'rgb(255, 241, 207)')

  await page.reload()
  await ready(page)
  await expect(root).toHaveAttribute('data-recent', 'true')
  await menuButton.click()
  await expect(slider).toHaveValue('10')

  const response = await page.request.post('/api/diagrams', { data: { title: 'Другая схема' } })
  const { id } = await response.json()
  await page.goto(`/diagram/${id}`)
  await ready(page)
  await expect(page.locator('[data-cell-id="root"]')).toHaveAttribute('data-recent', 'false')
  await menuButton.click()
  await expect(slider).toHaveValue('10')
})
