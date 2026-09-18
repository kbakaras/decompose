import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import * as Y from 'yjs'
import {
  DomainError,
  DocumentHistory,
  ROOT_ID,
  TreeCommands,
  getStructures,
  initializeDocument,
  projectTree,
} from '../../src/domain'
import { assertTreeInvariants, sequentialIds, cloneDocument, treeSnapshot } from './helpers'

describe('tree properties', () => {
  it('converges three replicas after reordered, duplicated and delayed updates', () => {
    fc.assert(fc.property(fc.array(fc.record({
      client: fc.integer({ min: 0, max: 2 }), operation: fc.integer({ min: 0, max: 7 }),
      first: fc.nat(), second: fc.nat(),
    }), { minLength: 20, maxLength: 100 }), steps => {
      const seed = new Y.Doc()
      initializeDocument(seed)
      const setup = new TreeCommands(seed, sequentialIds('seed'))
      setup.createChild(ROOT_ID)
      setup.createChild(ROOT_ID)
      const docs = Array.from({ length: 3 }, () => cloneDocument(seed))
      const commands = docs.map((doc, i) => new TreeCommands(doc, sequentialIds(`peer-${i}`)))
      const histories = docs.map(doc => new DocumentHistory(doc))
      const updates: Uint8Array[] = []
      docs.forEach(doc => doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== 'network') updates.push(update)
      }))
      for (const step of steps) {
        const doc = docs[step.client]
        const command = commands[step.client]
        const ids = [...projectTree(doc).nodes.keys()].sort()
        const source = ids[step.first % ids.length]
        const target = ids[step.second % ids.length]
        try {
          switch (step.operation) {
            case 0: command.createChild(source); break
            case 1: command.move(source, target, step.second % 3); break
            case 2: command.reorder(source, step.second % 2 === 0 ? -1 : 1); break
            case 3: command.deleteSubtree(source); break
            case 4: command.setText(source, `версия-${step.first}`); break
            case 5: if (updates.length) Y.applyUpdate(doc, updates[step.second % updates.length], 'network'); break
            case 6: histories[step.client].undo(); break
            case 7: histories[step.client].redo(); break
          }
        } catch (error) { if (!(error instanceof DomainError)) throw error }
        docs.forEach(replica => assertTreeInvariants(projectTree(replica)))
      }
      docs.forEach((doc, i) => {
        const delivery = i % 2 ? [...updates].reverse() : updates
        delivery.forEach(update => { Y.applyUpdate(doc, update, 'network'); Y.applyUpdate(doc, update, 'network') })
        assertTreeInvariants(projectTree(doc))
        // До доставки зависимостей delete set может прийти раньше нового значения.
        // Полноту raw-полей проверяем после доставки всех updates, проекцию — всегда.
        getStructures(doc).nodes.forEach(node => {
          for (const field of ['text', 'status', 'placement', 'deleted']) {
            expect(node.has(field), `Отсутствует поле ${field}`).toBe(true)
          }
        })
      })
      expect(treeSnapshot(docs[0])).toEqual(treeSnapshot(docs[1]))
      expect(treeSnapshot(docs[0])).toEqual(treeSnapshot(docs[2]))
      histories.forEach(history => history.destroy())
      docs.forEach(doc => doc.destroy())
      seed.destroy()
    }), { numRuns: 100 })
  })

  it('preserves invariants for arbitrary valid and rejected commands', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        operation: fc.integer({ min: 0, max: 6 }),
        first: fc.nat(),
        second: fc.nat(),
      }), { maxLength: 150 }),
      steps => {
        const doc = new Y.Doc()
        initializeDocument(doc)
        const commands = new TreeCommands(doc, sequentialIds('property'))

        for (const step of steps) {
          const tree = projectTree(doc)
          const ids = [...tree.nodes.keys()]
          const nonRoot = ids.filter(id => id !== ROOT_ID)
          const selected = ids[step.first % ids.length] ?? ROOT_ID
          const selectedNonRoot = nonRoot[step.first % Math.max(nonRoot.length, 1)]
          const target = ids[step.second % ids.length] ?? ROOT_ID

          try {
            switch (step.operation) {
              case 0:
                commands.createChild(selected)
                break
              case 1:
                if (selectedNonRoot !== undefined) commands.createSibling(selectedNonRoot)
                break
              case 2:
                if (selectedNonRoot !== undefined) commands.move(selectedNonRoot, target, step.second % 4)
                break
              case 3:
                if (selectedNonRoot !== undefined) commands.reorder(selectedNonRoot, step.second % 2 === 0 ? -1 : 1)
                break
              case 4:
                if (selectedNonRoot !== undefined) commands.indent(selectedNonRoot)
                break
              case 5:
                if (selectedNonRoot !== undefined) commands.outdent(selectedNonRoot)
                break
              case 6:
                if (selectedNonRoot !== undefined) commands.deleteSubtree(selectedNonRoot)
                break
            }
          } catch (error) {
            if (!(error instanceof DomainError)) throw error
          }

          assertTreeInvariants(projectTree(doc))
        }
      },
    ), { numRuns: 100 })
  })
})
