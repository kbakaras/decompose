import { test, expect, testDiagram } from './fixtures'

test('backup page downloads an archive and safely replaces an open diagram', async ({ page, context }) => {
  const diagramUrl = await testDiagram(page)
  const editor = await context.newPage()
  try {
    await editor.goto(diagramUrl)
    await expect(editor.locator('main')).toHaveAttribute('data-ready', 'true')
    await page.goto('/backup')
    await expect(page).toHaveURL(/\/backup$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Резервное копирование' })).toBeVisible()
    const downloadButton = page.getByRole('link', { name: 'Скачать ZIP-архив' })
    const restoreButton = page.getByRole('button', { name: 'Выбрать ZIP-архив' })
    const [downloadBox, restoreBox] = await Promise.all([downloadButton.boundingBox(), restoreButton.boundingBox()])
    expect(downloadBox).not.toBeNull()
    expect(restoreBox).not.toBeNull()
    expect(Math.abs(downloadBox!.y - restoreBox!.y)).toBeLessThan(1)
    const cards = page.locator('.backup-actions > section')
    const [downloadCard, restoreCard] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()])
    expect(downloadCard).not.toBeNull()
    expect(restoreCard).not.toBeNull()
    expect(downloadCard!.x + downloadCard!.width - downloadBox!.x - downloadBox!.width).toBeCloseTo(20, 0)
    expect(restoreCard!.x + restoreCard!.width - restoreBox!.x - restoreBox!.width).toBeCloseTo(20, 0)
    expect(downloadCard!.y + downloadCard!.height - downloadBox!.y - downloadBox!.height).toBeCloseTo(20, 0)
    expect(restoreCard!.y + restoreCard!.height - restoreBox!.y - restoreBox!.height).toBeCloseTo(20, 0)
    const downloadEvent = page.waitForEvent('download')
    await downloadButton.click()
    const download = await downloadEvent
    expect(download.suggestedFilename()).toMatch(/^decompose-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z\.zip$/)
    const path = await download.path()
    expect(path).not.toBeNull()

    await page.locator('input[type=file]').setInputFiles(path!)
    const result = page.getByRole('region', { name: 'Результат восстановления' })
    await expect(result).toBeVisible()
    const counts = (await result.locator('dd').allTextContents()).map(Number)
    expect(counts[0]).toBeGreaterThanOrEqual(1)
    expect(counts[1]).toBe(counts[0])
    expect(counts[2]).toBe(0)
    await expect(result.getByRole('heading', { name: 'Замещённые схемы' })).toBeVisible()
    await expect(editor).toHaveURL(diagramUrl)
    await expect(editor.locator('main')).toHaveAttribute('data-ready', 'true')
    await expect(editor.getByTestId('rf__node-root').getByText('Тестовая схема', { exact: true })).toBeVisible()
  } finally { await editor.close() }
})

test('backup page and API work behind a stripped reverse-proxy prefix', async ({ page }) => {
  const base = 'http://127.0.0.1:4183/decompose/'
  await page.goto(base + 'backup/')
  await expect(page).toHaveURL(base + 'backup')
  expect(await page.evaluate(() => document.baseURI)).toBe(base)
  await expect(page.getByRole('heading', { level: 1, name: 'Резервное копирование' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Скачать ZIP-архив' })).toHaveAttribute('href', base + 'api/backup')
})
