import { expect, test, namedContext, type Page } from './fixtures'

async function open(page: Page) {
  await page.goto('/')
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
  await expect(page.getByTestId('connection')).toHaveAttribute('data-connected', 'true')
}
const cell = (page: Page, id: string) => page.locator(`[data-cell-id="${id}"]`)
async function create(page: Page, key: string, text: string) {
  await page.keyboard.press(key)
  await page.getByRole('textbox').fill(text)
  await page.keyboard.press('Control+Enter')
  const active = page.locator('[data-cell-id][data-active="true"]')
  await expect(active).toHaveAttribute('data-text', text)
  return (await active.getAttribute('data-cell-id'))!
}

test('initial view appears in its final position on first load, reload and offline reload', async ({ page, browser }) => {
  await open(page)
  await cell(page, 'root').click()
  await create(page, 'Tab', 'Начальная раскладка')
  await create(page, 'Tab', 'Высокая клеточка. '.repeat(15))
  await create(page, 'Enter', 'Соседняя ветка')
  const leaf = await create(page, 'Tab', 'Глубокая деталь')
  const context = await namedContext(browser)
  const viewer = await context.newPage()
  try {
    await viewer.addInitScript(() => {
      const samples: { transform: string; x: number; y: number; width: number; height: number }[] = []
      Object.assign(window, { initialViewSamples: samples })
      const tick = () => {
        const node = document.querySelector<HTMLElement>('[data-cell-id="root"]')
        let visible = !!node
        for (let element: HTMLElement | null = node; element; element = element.parentElement) {
          const style = getComputedStyle(element)
          if (style.visibility === 'hidden' || Number(style.opacity) === 0) visible = false
        }
        if (visible && node) {
          const rect = node.getBoundingClientRect()
          samples.push({
            transform: getComputedStyle(document.querySelector('.react-flow__viewport')!).transform,
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          })
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    for (const mode of ['first', 'reload', 'offline']) {
      if (mode === 'offline') {
        await viewer.evaluate(async () => { await navigator.serviceWorker.ready })
        await context.setOffline(true)
        await viewer.evaluate(() => window.dispatchEvent(new Event('offline')))
      }
      if (mode === 'first') await viewer.goto('/')
      else await viewer.reload()
      await expect(viewer.locator('main')).toHaveAttribute('data-ready', 'true')
      await expect(cell(viewer, leaf)).toBeVisible()
      // Наблюдаем кадры и после готовности: прежние fitView/auto-pan срабатывали позже.
      await viewer.waitForTimeout(350)
      const samples = await viewer.evaluate(() => (
        window as unknown as { initialViewSamples: { transform: string; x: number; y: number; width: number; height: number }[] }
      ).initialViewSamples)
      expect(samples.length, mode).toBeGreaterThan(2)
      expect(new Set(samples.map(sample => JSON.stringify(sample))).size, mode).toBe(1)
      const centers = await viewer.evaluate(() => {
        const canvas = document.querySelector('main')!.getBoundingClientRect()
        const rects = [...document.querySelectorAll('[data-cell-id]')].map(node => node.getBoundingClientRect())
        return {
          canvasX: canvas.x + canvas.width / 2,
          diagramX: (Math.min(...rects.map(rect => rect.left)) + Math.max(...rects.map(rect => rect.right))) / 2,
        }
      })
      // React Flow округляет applied padding до целого пикселя.
      expect(Math.abs(centers.diagramX - centers.canvasX), mode).toBeLessThan(2)
    }
  } finally {
    await context.close()
  }
})

test('new cells are never shown at the origin while waiting for measured layout', async ({ page }) => {
  await open(page)
  await cell(page, 'root').click()
  await page.evaluate(() => {
    const known = new Set([...document.querySelectorAll<HTMLElement>('[data-cell-id]')].map(node => node.dataset.cellId))
    const samples: { x: number; parentX: number }[] = []
    Object.assign(window, { layoutSamples: samples })
    const sample = () => {
      for (const node of document.querySelectorAll<HTMLElement>('[data-cell-id]')) {
        if (known.has(node.dataset.cellId)) continue
        const wrapper = node.closest('.react-flow__node')!
        const style = getComputedStyle(wrapper)
        if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue
        const parent = document.querySelector(`[data-cell-id="${node.dataset.parentId}"]`)?.closest('.react-flow__node')
        if (!parent) continue
        samples.push({ x: new DOMMatrix(style.transform).m41, parentX: new DOMMatrix(getComputedStyle(parent).transform).m41 })
      }
    }
    const observer = new MutationObserver(sample)
    observer.observe(document.querySelector('main')!, { childList: true, subtree: true, attributes: true })
    let frame: number
    const tick = () => { sample(); frame = requestAnimationFrame(tick) }
    tick()
    window.addEventListener('stop-layout-probe', () => { observer.disconnect(); cancelAnimationFrame(frame) }, { once: true })
  })
  for (const key of ['Tab', 'Tab', 'Enter']) {
    if (key === 'Enter') await page.keyboard.press('Enter')
    await page.keyboard.press(key)
    await expect(page.getByRole('textbox')).toBeFocused()
    await page.keyboard.type('Сразу печатаю')
    await expect(page.getByRole('textbox')).toHaveValue('Сразу печатаю')
    await expect(page.locator('[data-active="true"]')).toHaveAttribute('data-layout-ready', 'true')
  }
  const samples = await page.evaluate(() => {
    window.dispatchEvent(new Event('stop-layout-probe'))
    return (window as unknown as { layoutSamples: { x: number; parentX: number }[] }).layoutSamples
  })
  expect(samples.length).toBeGreaterThan(0)
  expect(samples.filter(sample => sample.x <= sample.parentX)).toEqual([])
  await page.keyboard.press('Control+Enter')
})

async function dragTo(page: Page, sourceId: string, targetId: string, side: 'before' | 'after', fromPadding = false) {
  await page.getByRole('button', { name: 'Вся схема' }).click()
  const source = cell(page, sourceId)
  await source.click()
  await expect(source).toHaveClass(/cell-draggable/)
  await expect(source.locator('.cell-text')).toHaveCSS('cursor', 'move')
  // После удалённого изменения layout и fitView ещё могут менять геометрию.
  // Проверка actionability дожидается стабильных клеточек до измерения координат drag.
  await source.click({ trial: true })
  await cell(page, targetId).click({ trial: true })
  const from = (await source.boundingBox())!
  const text = (await source.locator('.cell-text').boundingBox())!
  const to = (await cell(page, targetId).boundingBox())!
  const startX = fromPadding ? from.x + from.width - 5 : text.x + text.width / 2
  const startY = fromPadding ? from.y + from.height - 5 : text.y + text.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY + 8, { steps: 3 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - from.height / 2 + startY - from.y + (side === 'before' ? -20 : 20), { steps: 15 })
  await expect(cell(page, targetId)).toHaveClass(new RegExp(`cell-drop-${side}`))
  await expect(page.getByTestId('drop-indicator')).toBeVisible()
  await expect(source).toHaveClass(/cell-dragging/)
  await expect(source.locator('.cell-text')).toHaveCSS('cursor', 'move')
}

test('canvas, root and a non-reorderable cell share pan cursors and move the viewport', async ({ page }) => {
  await open(page)
  await cell(page, 'root').click()
  await create(page, 'Tab', 'Проверка указателя холста')
  const onlyChild = await create(page, 'Tab', 'Единственный ребёнок')
  const pane = page.locator('.react-flow__pane')
  const viewport = page.locator('.react-flow__viewport')
  for (const id of ['root', onlyChild, null]) {
    await page.getByRole('button', { name: 'Вся схема' }).click()
    const target = id ? cell(page, id).locator('.cell-text') : pane
    await expect(target).toHaveCSS('cursor', 'grab')
    const bounds = (await target.boundingBox())!
    const x = bounds.x + (id ? bounds.width / 2 : 20)
    const y = bounds.y + (id ? bounds.height / 2 : 80)
    await page.mouse.move(x, y)
    expect(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, { x, y })).toBe('grab')
    const transform = await viewport.evaluate(element => getComputedStyle(element).transform)
    await page.mouse.down()
    await page.mouse.move(x + 35, y + 25, { steps: 5 })
    await expect(pane).toHaveClass(/dragging/)
    await expect(target).toHaveCSS('cursor', 'grabbing')
    await expect.poll(() => viewport.evaluate(element => getComputedStyle(element).transform)).not.toBe(transform)
    await expect(page.locator('.cell-dragging')).toHaveCount(0)
    await page.mouse.up()
    await expect(target).toHaveCSS('cursor', 'grab')
  }
})

test('only the active card can be reordered; dragging an inactive card pans without activating it', async ({ page }) => {
  const response = await page.request.post('/api/diagrams', { data: { title: 'Выбор перед перестановкой' } })
  const { id } = await response.json()
  await page.goto(`/?diagram=${id}`)
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
  await cell(page, 'root').click()
  const a = await create(page, 'Tab', 'Неактивная карточка')
  const b = await create(page, 'Enter', 'Активная карточка')
  await page.reload()
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true')
  await cell(page, b).click()
  const viewport = page.locator('.react-flow__viewport')
  const pane = page.locator('.react-flow__pane')
  const positions = () => page.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).style.transform))
  const beforePositions = await positions()
  for (const fromPadding of [false, true]) {
    await page.getByRole('button', { name: 'Вся схема' }).click()
    await cell(page, a).click({ trial: true })
    await expect(cell(page, a)).not.toHaveClass(/cell-draggable/)
    await expect(cell(page, a).locator('.cell-text')).toHaveCSS('cursor', 'grab')
    await expect(cell(page, b).locator('.cell-text')).toHaveCSS('cursor', 'move')
    const target = fromPadding ? cell(page, a) : cell(page, a).locator('.cell-text')
    const box = (await target.boundingBox())!
    const x = box.x + (fromPadding ? box.width - 4 : box.width / 2)
    const y = box.y + (fromPadding ? box.height - 4 : box.height / 2)
    const beforeViewport = await viewport.getAttribute('style')
    await page.mouse.move(x, y)
    await page.mouse.down()
    await expect(cell(page, a)).toHaveAttribute('data-active', 'false')
    await page.mouse.move(x + 75, y + 50, { steps: 10 })
    await expect(pane).toHaveClass(/dragging/)
    await expect(target).toHaveCSS('cursor', 'grabbing')
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforeViewport)
    await expect(cell(page, a)).toHaveAttribute('data-active', 'false')
    await expect(page.getByTestId('drop-indicator')).toHaveCount(0)
    await expect(page.locator('.cell-dragging')).toHaveCount(0)
    // Возврат к началу жеста также не должен превращать pan в click.
    if (fromPadding) await page.mouse.move(x, y, { steps: 10 })
    await page.mouse.up()
    await expect(cell(page, a)).toHaveAttribute('data-active', 'false')
    await expect(cell(page, b)).toHaveAttribute('data-active', 'true')
    await expect(cell(page, a)).toHaveAttribute('data-order', '0')
    await expect(cell(page, b)).toHaveAttribute('data-order', '1')
    expect(await positions()).toEqual(beforePositions)
    await expect(page.getByRole('button', { name: 'Отменить действие', exact: true })).toBeDisabled()
  }
  await cell(page, a).click()
  await expect(cell(page, a)).toHaveAttribute('data-active', 'true')
  await expect(cell(page, a).locator('.cell-text')).toHaveCSS('cursor', 'move')
  await expect(cell(page, b).locator('.cell-text')).toHaveCSS('cursor', 'grab')
  await page.keyboard.press('ArrowDown')
  await expect(cell(page, b)).toHaveAttribute('data-active', 'true')
  await expect(cell(page, b).locator('.cell-text')).toHaveCSS('cursor', 'move')
  await expect(cell(page, a).locator('.cell-text')).toHaveCSS('cursor', 'grab')
  await dragTo(page, b, a, 'before')
  const beforeDropViewport = await viewport.getAttribute('style')
  await page.mouse.up()
  await expect(cell(page, b)).toHaveAttribute('data-order', '0')
  await expect(cell(page, b)).toHaveAttribute('data-active', 'true')
  expect(await viewport.getAttribute('style')).toBe(beforeDropViewport)
})

test('mouse reorder commits on drop, syncs, preserves children and supports cancellation', async ({ browser }) => {
  const leftContext = await namedContext(browser)
  const rightContext = await namedContext(browser)
  const left = await leftContext.newPage()
  const right = await rightContext.newPage()
  try {
    await open(left)
    await open(right)
    await cell(left, 'root').click()
    const parent = await create(left, 'Tab', 'Мышиная перестановка')
    const a = await create(left, 'Tab', 'Мышь A')
    const b = await create(left, 'Enter', 'Мышь B — более длинная клеточка. '.repeat(5))
    const c = await create(left, 'Enter', 'Мышь C')
    const child = await create(left, 'Tab', 'Деталь C')
    await expect(cell(right, child)).toHaveAttribute('data-parent-id', c)
    await dragTo(left, c, a, 'before')
    await expect(cell(left, c)).toHaveAttribute('data-order', '2')
    await expect(cell(right, c)).toHaveAttribute('data-order', '2')
    await left.screenshot({ path: 'test-results/sibling-drag.png' })
    await left.mouse.up()
    await expect(cell(left, c)).toHaveAttribute('data-order', '0')
    await expect(cell(right, c)).toHaveAttribute('data-order', '0')
    await expect(cell(right, child)).toHaveAttribute('data-parent-id', c)
    await expect(cell(left, c)).toHaveAttribute('data-parent-id', parent)
    await expect(left.locator('main')).toBeFocused()

    await expect(cell(left, c)).not.toHaveClass(/cell-dragging/)
    await left.keyboard.press('Control+z')
    await expect(cell(left, c)).toHaveAttribute('data-order', '2')
    await expect(cell(right, c)).toHaveAttribute('data-order', '2')
    await left.keyboard.press('Control+Shift+z')
    await expect(cell(left, c)).toHaveAttribute('data-order', '0')
    await expect(cell(right, c)).toHaveAttribute('data-order', '0')

    await dragTo(left, c, b, 'after', true)
    await expect(left.getByRole('button', { name: 'Отменить действие', exact: true })).toBeDisabled()
    await left.keyboard.press('Control+z')
    await expect(cell(right, c)).toHaveAttribute('data-order', '0')
    await left.keyboard.press('Escape')
    await left.mouse.up()
    await expect(cell(left, c)).toHaveAttribute('data-order', '0')
    await expect(cell(left, b)).not.toHaveClass(/cell-drop-/)

    await dragTo(left, c, b, 'after')
    await cell(right, b).click()
    await right.keyboard.press('Delete')
    await expect(cell(left, b)).toHaveCount(0)
    await expect(cell(left, c)).not.toHaveClass(/cell-dragging/)
    await left.mouse.up()
    await expect(cell(left, c)).toHaveAttribute('data-order', '0')
    await expect(cell(right, c)).toHaveAttribute('data-order', '0')
    await expect(cell(left, 'root')).not.toHaveClass(/cell-draggable/)

    await dragTo(left, c, a, 'after')
    await cell(right, c).click()
    await right.keyboard.press('Shift+Tab')
    await expect(cell(left, c)).toHaveAttribute('data-parent-id', 'root')
    await expect(cell(left, c)).not.toHaveClass(/cell-dragging/)
    await left.mouse.up()
    await expect(cell(left, c)).toHaveAttribute('data-parent-id', 'root')
    await expect(cell(left, child)).toHaveAttribute('data-parent-id', c)
  } finally {
    await leftContext.close()
    await rightContext.close()
  }
})
