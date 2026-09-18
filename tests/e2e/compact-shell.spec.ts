import { expect, test } from '@playwright/test'

test('one compact header leaves all remaining space to the canvas on desktop and small screens', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
  await expect(page.locator('footer, .workspace-heading, .toolbar, .canvas-caption')).toHaveCount(0)
  const actions = page.getByRole('button', { name: 'Действия с клеточкой', exact: true })
  await page.locator('[data-cell-id="root"]').click()
  await page.keyboard.press('Escape')
  await expect(actions).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Удалить', exact: true })).toBeDisabled()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Дочерняя' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox')).toBeFocused()
  await page.getByRole('textbox').fill('Холст без лишних панелей')
  await page.keyboard.press('Enter')
  const id = await page.locator('[data-active="true"]').getAttribute('data-cell-id')
  const cell = page.locator(`[data-cell-id="${id}"]`)
  await expect(actions).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.notice')).toHaveCount(0)
  await actions.click()
  await page.getByRole('button', { name: 'Статус', exact: false }).click()
  await expect(cell).toHaveAttribute('data-status', 'done')
  await expect(page.locator('main')).toBeFocused()
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
  await expect(cell).toHaveAttribute('data-status', 'open')

  for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 667 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    const bounds = await page.evaluate(() => {
      const header = document.querySelector('header')!.getBoundingClientRect()
      const canvas = document.querySelector('main')!.getBoundingClientRect()
      return { headerHeight: header.height, top: canvas.top, bottom: canvas.bottom, width: canvas.width,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }
    })
    expect(bounds).toEqual({ headerHeight: 48, top: 48, bottom: viewport.height, width: viewport.width,
      scrollWidth: viewport.width, scrollHeight: viewport.height })
    for (const label of ['Отменить действие', 'Повторить действие', 'Вся схема', 'Клавиши', 'Действия с клеточкой']) {
      const button = page.getByRole('button', { name: label, exact: true })
      await expect(button).toBeInViewport()
      expect((await button.boundingBox())!.y).toBeLessThan(48)
    }
    await actions.click()
    await expect(page.getByRole('button', { name: 'Удалить', exact: true })).toBeInViewport()
    await page.keyboard.press('Escape')
    await expect(actions).toBeFocused()
    await expect(actions).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Клавиши', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Клавиатурная справка' })).toBeInViewport()
    await page.getByRole('button', { name: 'Вернуться к схеме' }).click()
    await expect(page.locator('main')).toBeFocused()
  }
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole('button', { name: 'Вся схема', exact: true }).click()
  await page.screenshot({ path: 'test-results/compact-shell.png' })
})

test('errors remain visible and dismissible without a status bar', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
  await page.locator('[data-cell-id="root"]').click()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toContainText('У root не может быть sibling')
  await page.getByRole('button', { name: 'Закрыть сообщение' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('main')).toBeFocused()
})
