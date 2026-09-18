export interface Identity { id: string; name: string; color: string }

let cached: Identity | undefined

export function browserIdentity(): Identity {
  if (cached) return cached
  const key = 'decompose:participant:v1'
  let id: string | null = null
  try { id = localStorage.getItem(key) } catch { /* Без хранилища идентичность живёт до reload. */ }
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    id = crypto.randomUUID()
    try { localStorage.setItem(key, id) } catch { /* Не блокируем работу схемы. */ }
  }
  const colors = ['#ad552b', '#457966', '#56649a', '#926581']
  cached = { id, name: `Участник ${id.slice(0, 4)}`, color: colors[parseInt(id.slice(0, 8), 16) % colors.length] }
  return cached
}
