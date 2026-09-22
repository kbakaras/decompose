import { expect, it, vi } from 'vitest'
import { createIdentityStore, identityKey, identityNameKey, initials, normalizeName } from '../../src/client/identity'
import { readParticipants, summarizeParticipants } from '../../src/client/presence'

const id = '12345678-1234-4234-8234-123456789abc'
function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

it('restores a chosen name, preserves legacy identity and color, and notifies without changing ID', () => {
  const local = storage()
  local.setItem(identityKey, id)
  const store = createIdentityStore(() => local)
  const original = store.snapshot()
  expect(original).toMatchObject({ id, name: null })
  const changed = vi.fn()
  const unsubscribe = store.subscribe(changed)
  expect(store.save('  Анна Иванова  ')).toBe(true)
  expect(store.snapshot()).toEqual({ ...original, name: 'Анна Иванова' })
  expect(changed).toHaveBeenCalledTimes(1)
  expect(createIdentityStore(() => local).snapshot()).toEqual(store.snapshot())
  local.setItem(identityNameKey, 'Анна')
  store.refresh()
  store.refresh()
  expect(changed).toHaveBeenCalledTimes(2)
  unsubscribe()
  store.save('Аня')
  expect(changed).toHaveBeenCalledTimes(2)
})

it('validates trimmed names and uses readable initials', () => {
  for (const value of ['', '   ', 'x'.repeat(81), 'Анна\nИванова']) expect(normalizeName(value)).toBeNull()
  expect(normalizeName(' x ')).toBe('x')
  expect(normalizeName('я'.repeat(80))).toHaveLength(80)
  expect(initials('Анна Иванова')).toBe('АИ')
  expect(initials('Анна')).toBe('АН')
  expect(initials('Я')).toBe('Я')
})

it('keeps an in-memory profile when storage is blocked and reports the persistence failure', () => {
  const store = createIdentityStore(() => { throw new Error('blocked') }, () => id)
  expect(store.snapshot().name).toBeNull()
  expect(store.save('Анна')).toBe(false)
  store.refresh()
  expect(store.snapshot()).toMatchObject({ id, name: 'Анна' })
  expect(() => store.save(' ')).toThrow()
})

it('ignores service states, hides guest selection and counts each browser once', () => {
  const participants = readParticipants([
    [1, {}], [2, { user: {} }],
    [3, { user: { id: 'guest', name: null }, activeNode: 'root', editingNode: 'root' }],
    [4, { user: { id: 'guest', name: null } }],
    [5, { user: { id: 'named', name: 'Анна', color: 'green' }, activeNode: 'root' }],
    [6, { user: { id: 'named', name: null } }],
  ])
  expect(participants).toHaveLength(4)
  expect(participants[0]).toMatchObject({ activeNode: null, editingNode: null })
  const summary = summarizeParticipants(participants, { id: 'guest', name: null, color: 'orange' })
  expect(summary.guests).toBe(1)
  expect(summary.named).toEqual([{ id: 'named', name: 'Анна', color: 'green' }])
  expect(summarizeParticipants(participants, { id: 'guest', name: 'Анна', color: 'orange' })).toMatchObject({ guests: 0 })
})

it('keeps roster identities in the header while selection remains awareness-only', () => {
  const participants = readParticipants([
    [1, { user: { id: 'active', name: 'Борис', color: 'green' }, activeNode: 'root' }],
  ])
  const summary = summarizeParticipants(participants, { id: 'self', name: 'Ольга', color: 'orange' }, [
    { connectionId: 'stale-tab', userId: 'stale', name: 'Анна', color: 'purple' },
    { connectionId: 'active-tab', userId: 'active', name: 'Борис', color: 'green' },
    { connectionId: 'second-active-tab', userId: 'active', name: 'Борис', color: 'green' },
    { connectionId: 'anonymous-tab', userId: 'anonymous', name: null, color: 'grey' },
  ])
  expect(summary.named.map(person => person.name)).toEqual(['Анна', 'Борис', 'Ольга'])
  expect(summary.guests).toBe(1)
  expect(participants).toEqual([expect.objectContaining({ userId: 'active', activeNode: 'root' })])
})

it('does not overwrite an unsaved in-memory name when readable storage has not changed', () => {
  const local = storage()
  local.setItem(identityKey, id)
  const store = createIdentityStore(() => ({ ...local, setItem: () => { throw new Error('readonly') } }))
  expect(store.save('Анна')).toBe(false)
  store.refresh()
  expect(store.snapshot().name).toBe('Анна')
})
