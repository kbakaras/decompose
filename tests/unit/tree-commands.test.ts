import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  DomainError,
  ROOT_ID,
  TreeCommands,
  initializeDocument,
  projectTree,
} from '../../src/domain'
import { assertTreeInvariants, sequentialIds } from './helpers'

function setup() {
  const doc = new Y.Doc()
  initializeDocument(doc)
  const commands = new TreeCommands(doc, sequentialIds('local'))
  return { doc, commands }
}

describe('TreeCommands', () => {
  it('creates, orders, indents and outdents nodes', () => {
    const { doc, commands } = setup()
    const first = commands.createChild(ROOT_ID, 'Первый')
    const second = commands.createSibling(first, 'Второй')
    const child = commands.createChild(first, 'Деталь')

    expect(projectTree(doc).children.get(ROOT_ID)).toEqual([first, second])
    expect(projectTree(doc).children.get(first)).toEqual([child])

    commands.indent(second)
    expect(projectTree(doc).children.get(first)).toEqual([child, second])

    commands.reorder(second, -1)
    expect(projectTree(doc).children.get(first)).toEqual([second, child])

    commands.outdent(second)
    expect(projectTree(doc).children.get(ROOT_ID)).toEqual([first, second])
    assertTreeInvariants(projectTree(doc))
  })

  it('stores text atomically and toggles status', () => {
    const { doc, commands } = setup()
    const node = commands.createChild(ROOT_ID)

    commands.setText(node, 'Строка\nбез переноса')
    commands.toggleStatus(node)

    expect(projectTree(doc).nodes.get(node)).toMatchObject({
      text: 'Строка без переноса',
      status: 'done',
    })
  })

  it('deletes the projected subtree but never root', () => {
    const { doc, commands } = setup()
    const parent = commands.createChild(ROOT_ID)
    const child = commands.createChild(parent)

    commands.deleteSubtree(parent)
    expect(projectTree(doc).nodes.has(parent)).toBe(false)
    expect(projectTree(doc).nodes.has(child)).toBe(false)
    expect(() => commands.deleteSubtree(ROOT_ID)).toThrowError(DomainError)
  })

  it('rejects local cycles', () => {
    const { commands } = setup()
    const parent = commands.createChild(ROOT_ID)
    const child = commands.createChild(parent)
    expect(() => commands.move(parent, child, 0)).toThrowError(
      expect.objectContaining({ code: 'cycle' }),
    )
  })
})
