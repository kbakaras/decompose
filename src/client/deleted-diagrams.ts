export interface DeletedDiagram { id: string; generation: number; operation: string; trackerKey?: string | null }
const prefix = 'decompose:deleted:'
const memory = new Map<string, DeletedDiagram>()
export class DiagramDeleted extends Error {
  constructor(readonly deletion: DeletedDiagram) { super('Схема удалена. Можно выбрать другую или открыть файл.') }
}
export function knownDeletion(id: string): DeletedDiagram | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(prefix + id) ?? 'null')
    if (value?.id === id && Number.isSafeInteger(value.generation) && typeof value.operation === 'string') memory.set(id, value)
  } catch { /* Отметка остаётся в памяти. */ }
  return memory.get(id)
}
export function rememberDeletion(value: DeletedDiagram) {
  memory.set(value.id, value)
  try {
    localStorage.setItem(prefix + value.id, JSON.stringify(value))
    for (const key of ['decompose:diagrams:v1', 'decompose:tracker:v1']) {
      const items = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (Array.isArray(items)) localStorage.setItem(key, JSON.stringify(items.filter(item => item?.id !== value.id)))
    }
  } catch { /* Сервер остаётся источником истины. */ }
  window.dispatchEvent(new CustomEvent('decompose:deleted', { detail: value }))
}
export function subscribeDeletion(id: string, listener: (value: DeletedDiagram) => void) {
  const check = () => { const value = knownDeletion(id); if (value) listener(value) }
  const changed = (event: StorageEvent) => { if (event.key === prefix + id) check() }
  window.addEventListener('storage', changed); window.addEventListener('decompose:deleted', check)
  return () => { window.removeEventListener('storage', changed); window.removeEventListener('decompose:deleted', check) }
}
export async function clearDeletedContent(value: DeletedDiagram) {
  try {
    for (const key of Object.keys(sessionStorage)) if (key === `decompose:pending:${value.id}` || key.startsWith(`decompose:pending:${value.id}~`)) sessionStorage.removeItem(key)
    localStorage.removeItem(`decompose:generation:${value.id}`)
  } catch { /* Необязательное хранилище может быть недоступно. */ }
  const names = typeof indexedDB.databases === 'function'
    ? (await indexedDB.databases()).map(db => db.name).filter((name): name is string => !!name && (name === `decompose:${value.id}:v1` || name.startsWith(`decompose:${value.id}~`)))
    : Array.from({ length: value.generation + 1 }, (_, n) => `decompose:${value.id}${n ? `~${n}` : ''}:v1`)
  await Promise.all(names.map(name => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error)
    // Чужая старая вкладка может держать БД открытой. Запрос остаётся в очереди,
    // но уход из удалённой схемы не должен зависеть от этой вкладки.
    request.onblocked = () => resolve()
  })))
}
