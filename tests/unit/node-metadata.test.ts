import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  DocumentHistory,
  ROOT_ID,
  TreeCommands,
  getStructures,
  initializeDocument,
  projectTree,
  readContentRevision,
  readNodeUpdate,
  readStatusRestore,
} from '../../src/domain'
import { cloneDocument, mergeDocuments, sequentialIds } from './helpers'

function changes(...values: Array<{ at: number; by: string }>) {
  let index = 0
  return () => values[index++] ?? values.at(-1) ?? null
}

describe('метаданные изменения карточки', () => {
  it('upgrades schema 2 without inventing metadata for old cards', () => {
    const doc = new Y.Doc()
    initializeDocument(doc)
    getStructures(doc).meta.set('schemaVersion', 2)
    initializeDocument(doc)
    expect(getStructures(doc).meta.get('schemaVersion')).toBe(3)
    expect(projectTree(doc).nodes.get(ROOT_ID)?.updated).toBeNull()
    doc.destroy()
  })

  it('updates them only for text and status, not for links or moves', () => {
    const doc = new Y.Doc()
    initializeDocument(doc)
    const commands = new TreeCommands(doc, sequentialIds('id'), changes(
      { at: 100, by: 'Алиса' },
      { at: 200, by: 'Борис' },
      { at: 300, by: 'Вера' },
    ))
    const child = commands.createChild(ROOT_ID, 'Черновик')
    expect(projectTree(doc).nodes.get(child)?.updated).toEqual({ at: 100, by: 'Алиса' })

    commands.setTrackerLink(child, 'TEST-1')
    commands.move(child, ROOT_ID, 0)
    expect(projectTree(doc).nodes.get(child)?.updated).toEqual({ at: 100, by: 'Алиса' })

    commands.setText(child, 'Готовый текст')
    expect(projectTree(doc).nodes.get(child)?.updated).toEqual({ at: 200, by: 'Борис' })
    commands.toggleStatus(child)
    expect(projectTree(doc).nodes.get(child)?.updated).toEqual({ at: 300, by: 'Вера' })
    doc.destroy()
  })

  it('restores metadata when status is toggled back without a text edit', () => {
    const doc = new Y.Doc()
    initializeDocument(doc)
    const commands = new TreeCommands(doc, sequentialIds('id'), changes(
      { at: 100, by: 'Алиса' },
      { at: 200, by: 'Борис' },
      { at: 300, by: 'Вера' },
    ))
    const child = commands.createChild(ROOT_ID, 'Задача')
    const record = getStructures(doc).nodes.get(child)!
    const originalRevision = readContentRevision(record)

    commands.toggleStatus(child)
    expect(readStatusRestore(record)).toEqual({
      status: 'open', updated: { at: 100, by: 'Алиса' }, contentRevision: originalRevision,
    })
    commands.toggleStatus(child)
    expect(projectTree(doc).nodes.get(child)).toMatchObject({
      status: 'open', updated: { at: 100, by: 'Алиса' },
    })
    expect(readStatusRestore(record)).toBeNull()
    doc.destroy()
  })

  it('does not restore stale metadata after an intervening text edit', () => {
    const doc = new Y.Doc()
    initializeDocument(doc)
    const commands = new TreeCommands(doc, sequentialIds('id'), changes(
      { at: 100, by: 'Алиса' },
      { at: 200, by: 'Борис' },
      { at: 300, by: 'Вера' },
      { at: 400, by: 'Глеб' },
    ))
    const child = commands.createChild(ROOT_ID, 'Задача')
    commands.toggleStatus(child)
    commands.setText(child, 'Уточнённая задача')
    expect(readStatusRestore(getStructures(doc).nodes.get(child)!)).toBeNull()
    commands.toggleStatus(child)
    expect(projectTree(doc).nodes.get(child)?.updated).toEqual({ at: 400, by: 'Глеб' })
    doc.destroy()
  })

  it('restores metadata together with state on undo and redo', () => {
    const doc = new Y.Doc()
    initializeDocument(doc)
    const commands = new TreeCommands(doc, sequentialIds('id'), changes(
      { at: 100, by: 'Алиса' }, { at: 200, by: 'Борис' },
    ))
    const child = commands.createChild(ROOT_ID, 'До')
    const history = new DocumentHistory(doc)
    commands.setText(child, 'После')
    expect(projectTree(doc).nodes.get(child)?.updated).toEqual({ at: 200, by: 'Борис' })
    history.undo()
    expect(projectTree(doc).nodes.get(child)).toMatchObject({ text: 'До', updated: { at: 100, by: 'Алиса' } })
    history.redo()
    expect(projectTree(doc).nodes.get(child)).toMatchObject({ text: 'После', updated: { at: 200, by: 'Борис' } })
    history.destroy()
    doc.destroy()
  })

  it('keeps a concurrent text revision from reviving status metadata', () => {
    const base = new Y.Doc()
    initializeDocument(base)
    const seed = new TreeCommands(base, sequentialIds('seed'), changes({ at: 100, by: 'Алиса' }))
    const child = seed.createChild(ROOT_ID, 'Исходный текст')
    const left = cloneDocument(base)
    const right = cloneDocument(base)
    new TreeCommands(left, sequentialIds('left'), changes({ at: 200, by: 'Борис' })).toggleStatus(child)
    new TreeCommands(right, sequentialIds('right'), changes({ at: 300, by: 'Вера' })).setText(child, 'Новый текст')
    const merged = mergeDocuments(left, right)
    const record = getStructures(merged).nodes.get(child)!
    const restore = readStatusRestore(record)
    expect(readContentRevision(record)).not.toBe(restore?.contentRevision)
    expect(readNodeUpdate(record)).not.toBeNull()
    base.destroy(); left.destroy(); right.destroy(); merged.destroy()
  })
})
