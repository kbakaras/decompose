import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { initializeDocument, ROOT_ID, TreeCommands, projectTree } from '../../src/domain'
import { layoutTree, NODE_MIN_HEIGHT } from '../../src/client/layout'

it('preserves sibling order across unequal sizes and reordered subtrees', async () => {
  const doc = new Y.Doc()
  initializeDocument(doc)
  const commands = new TreeCommands(doc)
  const a = commands.createChild(ROOT_ID)
  const b = commands.createChild(ROOT_ID)
  const c = commands.createChild(ROOT_ID)
  commands.createChild(a)
  commands.createChild(a)
  commands.createChild(c)
  commands.move(c, ROOT_ID, 0)
  const tree = projectTree(doc)
  const positions = await layoutTree(tree, new Map([[a, 320], [b, 80], [c, 145]]))
  for (const [parent, children] of tree.children) {
    for (let index = 0; index < children.length; index++) {
      expect(positions.get(children[index])!.x).toBeGreaterThan(positions.get(parent)!.x)
      if (index > 0) expect(positions.get(children[index])!.y).toBeGreaterThan(positions.get(children[index - 1])!.y)
    }
  }
})

it('centers a parent between equally sized children', async () => {
  const doc = new Y.Doc()
  initializeDocument(doc)
  const commands = new TreeCommands(doc)
  const children = Array.from({ length: 3 }, () => commands.createChild(ROOT_ID))
  const positions = await layoutTree(projectTree(doc), new Map())
  expect(positions.get(ROOT_ID)!.y).toBeCloseTo(
    (positions.get(children[0])!.y + positions.get(children[2])!.y) / 2,
  )
  doc.destroy()
})

it('avoids flipping ancestor alignment when adjacent uneven subtrees are swapped', async () => {
  // Обезличенная структура со снимков; высоты приближены, тексты не нужны.
  const children: Record<string, string[]> = {
    root: ['a', 'b', 'c'],
    a: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
    a2: ['a21'], a5: ['a51'], a6: ['a61', 'a62'],
    b: ['b1', 'b2', 'b3', 'b4'],
    b1: ['b11'], b2: ['b21'], b3: ['b31', 'b32'],
    c: ['c1', 'c2', 'c3', 'c4'], c1: ['c11'], c11: ['c111'],
  }
  const sizes: Record<string, number> = {
    root: 88, a: 44, b: 44, c: 44,
    a1: 88, a2: 88, a3: 88, a4: 88, a5: 88, a6: 88,
    a21: 44, a51: 66, a61: 88, a62: 66,
    b1: 88, b2: 110, b3: 66, b4: 88, b11: 88, b21: 66, b31: 66, b32: 88,
    c1: 44, c2: 44, c3: 44, c4: 88, c11: 66, c111: 88,
  }
  const doc = new Y.Doc()
  initializeDocument(doc)
  const commands = new TreeCommands(doc)
  const ids = new Map([['root', ROOT_ID]])
  const create = (parent: string) => {
    for (const child of children[parent] ?? []) {
      ids.set(child, commands.createChild(ids.get(parent)!))
      create(child)
    }
  }
  create('root')
  const heights = new Map(Object.entries(sizes).map(([name, height]) => [ids.get(name)!, height]))
  const before = await layoutTree(projectTree(doc), heights)
  commands.move(ids.get('a5')!, ids.get('a')!, 3)
  const tree = projectTree(doc)
  const after = await layoutTree(tree, heights)

  // Для этого примера допускаем небольшое уплотнение, но не смену края выравнивания.
  for (const name of ['root', 'a', 'b', 'c']) {
    const id = ids.get(name)!
    expect(Math.abs(after.get(id)!.y - before.get(id)!.y)).toBeLessThanOrEqual(NODE_MIN_HEIGHT)
    expect(after.get(id)!.x).toBe(before.get(id)!.x)
  }
  for (const [parent, siblings] of tree.children) {
    for (const [index, id] of siblings.entries()) {
      expect(after.get(id)!.x).toBeGreaterThan(after.get(parent)!.x)
      if (index > 0) {
        const previous = siblings[index - 1]
        expect(after.get(id)!.y).toBeGreaterThanOrEqual(after.get(previous)!.y + heights.get(previous)!)
      }
    }
  }
  commands.move(ids.get('a5')!, ids.get('a')!, 4)
  expect(await layoutTree(projectTree(doc), heights)).toEqual(before)
  doc.destroy()
})
