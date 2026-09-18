import { test as base, type Browser, type BrowserContext } from '@playwright/test'

export { expect, type Page, type Locator } from '@playwright/test'

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
