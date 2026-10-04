import { expect, it } from 'vitest'
import {
  DEFAULT_RECENT_LOOKBACK_INDEX,
  RECENT_LOOKBACK_DAYS,
  RECENT_UPDATES_STORAGE_KEY,
  readRecentLookbackIndex,
  recentThreshold,
  saveRecentLookbackIndex,
} from '../../src/client/recent-updates'

it('uses a global persisted lookback value and rejects unknown values', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  expect(readRecentLookbackIndex(storage)).toBe(DEFAULT_RECENT_LOOKBACK_INDEX)
  saveRecentLookbackIndex(RECENT_LOOKBACK_DAYS.indexOf(2), storage)
  expect(values.get(RECENT_UPDATES_STORAGE_KEY)).toBe('2')
  expect(readRecentLookbackIndex(storage)).toBe(RECENT_LOOKBACK_DAYS.indexOf(2))
  values.set(RECENT_UPDATES_STORAGE_KEY, '8')
  expect(readRecentLookbackIndex(storage)).toBe(DEFAULT_RECENT_LOOKBACK_INDEX)
})

it('turns the rightmost position off and uses rolling 24-hour days', () => {
  const now = Date.UTC(2026, 9, 1, 12)
  expect(recentThreshold(DEFAULT_RECENT_LOOKBACK_INDEX, now)).toBeNull()
  expect(recentThreshold(RECENT_LOOKBACK_DAYS.indexOf(1), now)).toBe(now - 24 * 60 * 60 * 1000)
  expect(RECENT_LOOKBACK_DAYS).toEqual([30, 28, 21, 14, 7, 6, 5, 4, 3, 2, 1, 0])
})
