import { expect, it } from 'vitest'
import { normalizeAppVersion } from '../../src/client/version'

it('uses local for an unspecified build version', () => {
  expect(normalizeAppVersion(undefined)).toBe('local')
  expect(normalizeAppVersion('  ')).toBe('local')
})

it('keeps a supplied release version without a tag prefix', () => {
  expect(normalizeAppVersion(' 1.2.3-rc.1 ')).toBe('1.2.3-rc.1')
})
