import { createUuid } from '../shared/uuid'

export interface Identity { id: string; name: string | null; color: string }

export const identityKey = 'decompose:participant:v1'
export const identityNameKey = 'decompose:participant-name:v1'

export function normalizeName(value: string): string | null {
  const name = value.trim()
  return name && [...name].length <= 80 && !/[\r\n]/.test(name) ? name : null
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/)
  return (words.length > 1 ? [...words[0]][0] + [...words.at(-1)!][0] : [...name].slice(0, 2).join('')).toLocaleUpperCase()
}

export function createIdentityStore(storage: () => Pick<Storage, 'getItem' | 'setItem'>, randomId = createUuid) {
  let id: string | null = null
  let name: string | null = null
  try {
    id = storage().getItem(identityKey)
    name = normalizeName(storage().getItem(identityNameKey) ?? '')
  } catch { /* Без хранилища профиль живёт до reload. */ }
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    id = randomId()
    try { storage().setItem(identityKey, id) } catch { /* Не блокируем просмотр. */ }
  }
  const colors = ['#ad552b', '#457966', '#56649a', '#926581']
  let current: Identity = { id, name, color: colors[parseInt(id.slice(0, 8), 16) % colors.length] }
  let storedName = name
  const listeners = new Set<() => void>()
  const update = (nextName: string | null) => {
    if (current.name === nextName) return
    current = { ...current, name: nextName }
    listeners.forEach(listener => listener())
  }
  return {
    snapshot: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh() {
      try {
        const nextName = normalizeName(storage().getItem(identityNameKey) ?? '')
        // Не затираем профиль в памяти неизменившимся хранилищем после неудачной записи.
        if (nextName !== storedName) { storedName = nextName; update(nextName) }
      } catch { /* Оставляем профиль в памяти. */ }
    },
    save(value: string) {
      const nextName = normalizeName(value)
      if (!nextName) throw new Error('Введи имя длиной от 1 до 80 символов.')
      let persisted = true
      try {
        storage().setItem(identityKey, current.id)
        storage().setItem(identityNameKey, nextName)
        storedName = nextName
      } catch { persisted = false }
      update(nextName)
      return persisted
    },
  }
}

let store: ReturnType<typeof createIdentityStore> | undefined
const browserStore = () => store ??= createIdentityStore(() => localStorage)
export const browserIdentity = () => browserStore().snapshot()
export const saveIdentityName = (name: string) => browserStore().save(name)
export const refreshIdentity = () => browserStore().refresh()
export function subscribeIdentity(listener: () => void) {
  const unsubscribe = browserStore().subscribe(listener)
  const changed = (event: StorageEvent) => {
    if (event.key === identityNameKey || event.key === null) refreshIdentity()
  }
  window.addEventListener('storage', changed)
  return () => { unsubscribe(); window.removeEventListener('storage', changed) }
}
