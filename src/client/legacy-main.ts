import { clearDeletedContent } from './deleted-diagrams'

/** Очистка только упразднённой стартовой схемы, без сброса профиля и остальных документов. */
export async function clearLegacyMain() {
  let generation = 0
  try {
    const cached = Number(localStorage.getItem('decompose:generation:main'))
    if (Number.isSafeInteger(cached) && cached >= 0) generation = cached
    for (const key of ['decompose:diagrams:v1', 'decompose:tracker:v1']) {
      const items: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (Array.isArray(items) && items.some(item => item?.id === 'main')) {
        localStorage.setItem(key, JSON.stringify(items.filter(item => item?.id !== 'main')))
      }
    }
    localStorage.removeItem('decompose:deleted:main')
  } catch { /* Недоступный кеш не мешает открыть титульную страницу. */ }
  await clearDeletedContent({ id: 'main', generation, operation: 'retire-main' })
}
