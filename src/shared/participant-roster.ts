export const PARTICIPANT_ROSTER_VERSION = 1

export interface ParticipantRosterMember {
  connectionId: string
  userId: string
  name: string | null
  color: string
}

export interface ParticipantRoster {
  type: 'participant-roster'
  version: typeof PARTICIPANT_ROSTER_VERSION
  participants: ParticipantRosterMember[]
}

export function isParticipantRoster(value: unknown): value is ParticipantRoster {
  if (!value || typeof value !== 'object') return false
  const roster = value as Partial<ParticipantRoster>
  if (roster.type !== 'participant-roster' || roster.version !== PARTICIPANT_ROSTER_VERSION
    || !Array.isArray(roster.participants)) return false
  return roster.participants.every(participant => !!participant && typeof participant === 'object'
    && typeof participant.connectionId === 'string' && participant.connectionId.length > 0
    && typeof participant.userId === 'string' && participant.userId.length > 0
    && (participant.name === null || typeof participant.name === 'string')
    && typeof participant.color === 'string')
}
