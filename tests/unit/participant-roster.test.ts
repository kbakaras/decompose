import { expect, it } from 'vitest'
import { isParticipantRoster } from '../../src/shared/participant-roster'

it('validates versioned participant rosters', () => {
  expect(isParticipantRoster({
    type: 'participant-roster', version: 1,
    participants: [{ connectionId: 'socket', userId: 'profile', name: 'Анна', color: '#457966' }],
  })).toBe(true)
  expect(isParticipantRoster({
    type: 'participant-roster', version: 1,
    participants: [{ connectionId: 'socket', userId: 'profile', name: 42, color: '#457966' }],
  })).toBe(false)
  expect(isParticipantRoster({ type: 'participant-roster', version: 2, participants: [] })).toBe(false)
})
