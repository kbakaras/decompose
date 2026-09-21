import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  ROOT_ID,
  TreeCommands,
  captureSubtree,
  initializeDocument,
  projectTree,
} from '../../src/domain'
import {
  assertTreeInvariants,
  cloneDocument,
  mergeDocuments,
  sequentialIds,
  treeSnapshot,
} from './helpers'

function baseTree() {
  const doc = new Y.Doc()
  initializeDocument(doc)
  const commands = new TreeCommands(doc, sequentialIds('base'))
  const first = commands.createChild(ROOT_ID, 'A')
  const second = commands.createChild(ROOT_ID, 'B')
  const moving = commands.createChild(first, 'X')
  return { doc, first, second, moving }
}

function expectConvergence(left: Y.Doc, right: Y.Doc) {
  const forward = mergeDocuments(left, right)
  const reverse = mergeDocuments(left, right, true)
  expect(treeSnapshot(forward)).toEqual(treeSnapshot(reverse))
  assertTreeInvariants(projectTree(forward))
  assertTreeInvariants(projectTree(reverse))
  return forward
}

describe('concurrent tree operations', () => {
  it('chooses one complete placement for concurrent reparent', () => {
    const { doc, first, second, moving } = baseTree()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)

    new TreeCommands(left, sequentialIds('left')).move(moving, second, 0)
    new TreeCommands(right, sequentialIds('right')).move(moving, ROOT_ID, 0)

    const merged = expectConvergence(left, right)
    const node = projectTree(merged).nodes.get(moving)
    expect([ROOT_ID, second]).toContain(node?.parentId)
    expect(node?.parentId).not.toBe(first)
  })

  it('repairs a cycle created by two valid concurrent moves', () => {
    const { doc, first, second } = baseTree()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)

    new TreeCommands(left, sequentialIds('left')).move(first, second, 0)
    new TreeCommands(right, sequentialIds('right')).move(second, first, 0)

    const tree = projectTree(expectConvergence(left, right))
    expect([tree.nodes.get(first)?.recovered, tree.nodes.get(second)?.recovered]).toContain(true)
  })

  it('keeps both concurrent insertions at one position', () => {
    const { doc } = baseTree()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)
    const leftNode = new TreeCommands(left, sequentialIds('left')).createChild(ROOT_ID, 'L')
    const rightNode = new TreeCommands(right, sequentialIds('right')).createChild(ROOT_ID, 'R')

    const tree = projectTree(expectConvergence(left, right))
    expect(tree.nodes.has(leftNode)).toBe(true)
    expect(tree.nodes.has(rightNode)).toBe(true)
  })

  it('makes delete win over edit and move of an observed node', () => {
    const { doc, second, moving } = baseTree()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)

    new TreeCommands(left, sequentialIds('left')).deleteSubtree(moving)
    const rightCommands = new TreeCommands(right, sequentialIds('right'))
    rightCommands.setText(moving, 'Изменено offline')
    rightCommands.move(moving, second, 0)

    expect(projectTree(expectConvergence(left, right)).nodes.has(moving)).toBe(false)
  })

  it('recovers an unobserved concurrent child under root', () => {
    const { doc, first } = baseTree()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)

    new TreeCommands(left, sequentialIds('left')).deleteSubtree(first)
    const newChild = new TreeCommands(right, sequentialIds('right')).createChild(first, 'Новый')

    const tree = projectTree(expectConvergence(left, right))
    expect(tree.nodes.get(newChild)).toMatchObject({ parentId: ROOT_ID, recovered: true })
  })

  it('keeps a cut snapshot fixed while recovering a child created concurrently', () => {
    const { doc, first } = baseTree()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)
    const snapshot = captureSubtree(projectTree(left), first)

    new TreeCommands(left, sequentialIds('left')).deleteSubtree(first)
    const lateChild = new TreeCommands(right, sequentialIds('right')).createChild(first, 'Поздний ребёнок')
    const merged = expectConvergence(left, right)
    const tree = projectTree(merged)
    expect(tree.nodes.get(lateChild)).toMatchObject({ parentId: ROOT_ID, recovered: true })
    expect(snapshot.nodes.some(node => node.id === lateChild)).toBe(false)

    const copy = new TreeCommands(merged, sequentialIds('copy')).insertSubtree(ROOT_ID, snapshot)
    expect(projectTree(merged).children.get(copy)).toHaveLength(1)
    assertTreeInvariants(projectTree(merged))
  })

  it('converges when a subtree is pasted while its destination is moved', () => {
    const { doc, first, second } = baseTree()
    const snapshot = captureSubtree(projectTree(doc), first)
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)

    const copy = new TreeCommands(left, sequentialIds('copy')).insertSubtree(second, snapshot)
    new TreeCommands(right, sequentialIds('right')).move(second, first, 0)

    const tree = projectTree(expectConvergence(left, right))
    expect(tree.nodes.get(copy)?.parentId).toBe(second)
    expect(tree.children.get(copy)).toHaveLength(1)
  })

  it('keeps one whole text after concurrent cell edits', () => {
    const { doc, moving } = baseTree()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)

    new TreeCommands(left).setText(moving, 'Левая полная версия')
    new TreeCommands(right).setText(moving, 'Правая полная версия')

    const text = projectTree(expectConvergence(left, right)).nodes.get(moving)?.text
    expect(['Левая полная версия', 'Правая полная версия']).toContain(text)
  })

  it('converges when a tracker link is concurrently replaced and removed', () => {
    const { doc, moving } = baseTree()
    new TreeCommands(doc).setTrackerLink(moving, 'BASE-1')
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)

    new TreeCommands(left).setTrackerLink(moving, 'LEFT-2')
    new TreeCommands(right).setTrackerLink(moving, null)

    const value = projectTree(expectConvergence(left, right)).nodes.get(moving)?.targetTrackerKey
    expect([null, 'LEFT-2']).toContain(value)
  })

  it('preserves visible order when inserting and reordering recovered siblings', () => {
    const { doc, first, second } = baseTree()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)
    new TreeCommands(left).deleteSubtree(first)
    const offline = new TreeCommands(right, sequentialIds('offline'))
    const a = offline.createChild(first, 'A')
    const b = offline.createChild(first, 'B')
    const merged = expectConvergence(left, right)
    expect(projectTree(merged).children.get(ROOT_ID)).toEqual([second, a, b])
    const commands = new TreeCommands(merged, sequentialIds('after-merge'))
    const between = commands.createSibling(a, 'Между восстановленными')
    expect(projectTree(merged).children.get(ROOT_ID)).toEqual([second, a, between, b])
    commands.reorder(b, -1)
    expect(projectTree(merged).children.get(ROOT_ID)).toEqual([second, a, b, between])
    const last = commands.createChild(ROOT_ID, 'Последний')
    expect(projectTree(merged).children.get(ROOT_ID)).toEqual([second, a, b, between, last])
    assertTreeInvariants(projectTree(merged))
  })

  it('projects conflicts without writing repair updates', () => {
    const { doc, first, second } = baseTree()
    const left = cloneDocument(doc)
    const right = cloneDocument(doc)
    new TreeCommands(left, sequentialIds('left')).move(first, second, 0)
    new TreeCommands(right, sequentialIds('right')).move(second, first, 0)
    const merged = expectConvergence(left, right)
    let updates = 0
    merged.on('update', () => { updates++ })
    projectTree(merged)
    projectTree(merged)
    expect(updates).toBe(0)
  })
})
