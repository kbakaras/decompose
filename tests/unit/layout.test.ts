import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { initializeDocument, ROOT_ID, TreeCommands, projectTree } from '../../src/domain'
import { layoutTree } from '../../src/client/layout'

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
