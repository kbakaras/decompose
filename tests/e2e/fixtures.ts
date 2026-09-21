import { test as base, type Browser, type BrowserContext, type Page } from '@playwright/test'

export { expect, type Page, type Locator } from '@playwright/test'

const testDiagrams = new Map<string, string>()
/** Явная независимая схема для сценария; дополнительные клиенты открывают тот же UUID. */
export async function testDiagram(page: Page, baseUrl = 'http://127.0.0.1:4173/'): Promise<string> {
  const info = base.info(), key = `${info.testId}:${info.retry}:${info.repeatEachIndex}`
  let id = testDiagrams.get(key)
  if (!id) {
    const response = await page.request.post(new URL('api/diagrams', baseUrl).href, { data: { title: 'Тестовая схема' } })
    if (response.status() !== 201) throw new Error('Не удалось создать тестовую схему')
    id = (await response.json()).id as string
    testDiagrams.set(key, id)
  }
  return new URL(`diagram/${id}`, baseUrl).href
}

async function seedIdentity(context: BrowserContext) {
  await context.addInitScript(() => {
    if (!localStorage.getItem('decompose:participant-name:v1')) {
      localStorage.setItem('decompose:participant-name:v1', 'Участник теста')
    }
  })
}

// Существующие сценарии проверяют редактор уже представившегося пользователя.
// Знакомство и гостевой режим проверяются отдельно, без этой fixture.
export const test = base.extend({
  context: async ({ context }, use) => { await seedIdentity(context); await use(context) },
})
export async function namedContext(browser: Browser) {
  const context = await browser.newContext()
  await seedIdentity(context)
  return context
}
