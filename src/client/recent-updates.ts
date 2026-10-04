export const RECENT_UPDATES_STORAGE_KEY = 'decompose:recent-updates:v1'
export const RECENT_LOOKBACK_DAYS = [30, 28, 21, 14, 7, 6, 5, 4, 3, 2, 1, 0] as const
export const DEFAULT_RECENT_LOOKBACK_INDEX = RECENT_LOOKBACK_DAYS.length - 1

export function readRecentLookbackIndex(storage: Pick<Storage, 'getItem'> = localStorage): number {
  try {
    const days = Number(storage.getItem(RECENT_UPDATES_STORAGE_KEY))
    const index = RECENT_LOOKBACK_DAYS.indexOf(days as typeof RECENT_LOOKBACK_DAYS[number])
    return index >= 0 ? index : DEFAULT_RECENT_LOOKBACK_INDEX
  } catch {
    return DEFAULT_RECENT_LOOKBACK_INDEX
  }
}

export function saveRecentLookbackIndex(index: number, storage: Pick<Storage, 'setItem'> = localStorage): void {
  const days = RECENT_LOOKBACK_DAYS[index]
  if (days === undefined) return
  try { storage.setItem(RECENT_UPDATES_STORAGE_KEY, String(days)) }
  catch { /* Настройка остаётся в памяти до перезагрузки. */ }
}

export function recentThreshold(index: number, now = Date.now()): number | null {
  const days = RECENT_LOOKBACK_DAYS[index]
  return days ? now - days * 24 * 60 * 60 * 1000 : null
}

export function recentLookbackLabel(index: number): string {
  const days = RECENT_LOOKBACK_DAYS[index] ?? 0
  if (days === 0) return 'Не выделять недавние изменения'
  if (days === 1) return 'Изменения за последний день'
  const remainder = days % 100
  const word = remainder >= 11 && remainder <= 14 ? 'дней'
    : days % 10 === 1 ? 'день'
      : days % 10 >= 2 && days % 10 <= 4 ? 'дня' : 'дней'
  return `Изменения за ${days} ${word}`
}
