import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { initializeDocument, ROOT_ID, TreeCommands, projectTree } from '../../src/domain'
import { focusAfterRemoval, navigate } from '../../src/client/interaction'

it('keeps focus on moved nodes and chooses a surviving sibling after deletion', () => {
  const doc = new Y.Doc()
  initializeDocument(doc)
  const commands = new TreeCommands(doc)
  const a = commands.createChild(ROOT_ID)
  const b = commands.createChild(ROOT_ID)
  const c = commands.createChild(ROOT_ID)
  const before = projectTree(doc)
  expect(navigate(before, b, 'ArrowUp')).toBe(a)
  expect(navigate(before, b, 'ArrowDown')).toBe(c)
  expect(navigate(before, b, 'ArrowLeft')).toBe(ROOT_ID)
  commands.move(b, a, 0)
  expect(focusAfterRemoval(before, projectTree(doc), b)).toBe(b)
  commands.deleteSubtree(b)
  expect(focusAfterRemoval(before, projectTree(doc), b)).toBe(c)
  commands.deleteSubtree(c)
  expect(focusAfterRemoval(before, projectTree(doc), b)).toBe(a)
  commands.deleteSubtree(a)
  expect(focusAfterRemoval(before, projectTree(doc), b)).toBe(ROOT_ID)
})
