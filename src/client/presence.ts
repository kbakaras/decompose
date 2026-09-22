import type { Identity } from './identity'
import type { ParticipantRosterMember } from '../shared/participant-roster'

export interface Participant {
  clientId: number
  userId: string
  name: string | null
  color: string
  activeNode: string | null
  editingNode: string | null
}

export function readParticipants(states: Iterable<[number, Record<string, unknown>]>): Participant[] {
  return [...states].flatMap(([clientId, state]) => {
    if (!state.user || typeof state.user !== 'object') return []
    const user = state.user as Record<string, unknown>
    if (typeof user.id !== 'string' && typeof user.name !== 'string') return []
    const name = typeof user.name === 'string' && user.name.trim() ? user.name : null
    return [{
      clientId, userId: typeof user.id === 'string' ? user.id : `legacy:${clientId}`, name,
      color: typeof user.color === 'string' ? user.color : '#777',
      activeNode: name && typeof state.activeNode === 'string' ? state.activeNode : null,
      editingNode: name && typeof state.editingNode === 'string' ? state.editingNode : null,
    }]
  })
}

export function summarizeParticipants(participants: Participant[], self: Identity, roster: ParticipantRosterMember[] = []) {
  const users = new Map<string, Identity>()
  for (const person of roster) users.set(person.userId, { id: person.userId, name: person.name, color: person.color })
  for (const person of participants) {
    // При переходе гостя к имени временно могут присутствовать обе версии из разных вкладок.
    if (!users.has(person.userId) || person.name) users.set(person.userId, { id: person.userId, name: person.name, color: person.color })
  }
  users.set(self.id, self)
  return {
    named: [...users.values()].filter((user): user is Identity & { name: string } => user.name !== null),
    guests: [...users.values()].filter(user => user.name === null).length,
  }
}
