import { expect, it } from 'vitest'
import fc from 'fast-check'
import * as Y from 'yjs'
import { DocumentHistory, TreeCommands, ROOT_ID, getStructures, initializeDocument, normalizeText, projectTree, readTextAlign } from '../../src/domain'
import { diagramTitle } from '../../src/shared/diagrams'
import { cloneDocument, mergeDocuments, treeSnapshot } from './helpers'

function setup() {
  const doc = new Y.Doc()
  initializeDocument(doc)
  return { doc, commands: new TreeCommands(doc), history: new DocumentHistory(doc) }
}

it('normalizes CRLF and CR without removing consecutive or trailing soft line breaks', () => {
  expect(normalizeText('Первая\r\n\rВторая\n\n')).toBe('Первая\n\nВторая\n\n')
  expect(diagramTitle('  Первая\r\n\nВторая\n')).toBe('Первая Вторая')
  expect(diagramTitle('\n \r\n')).toBe('Новая декомпозиция')
  fc.assert(fc.property(fc.array(fc.string(), { maxLength: 20 }), parts => {
    const normalized = normalizeText(parts.join('\r\n'))
    expect(normalizeText(normalized)).toBe(normalized)
    expect(normalized).not.toContain('\r')
    expect(normalized.split('\n').length).toBeGreaterThanOrEqual(parts.length)
  }))
})

it('commits multiline text as one atomic history step', () => {
  const { doc, commands, history } = setup()
  try {
    const before = projectTree(doc).nodes.get(ROOT_ID)!.text
    commands.setText(ROOT_ID, 'Первая\r\nВторая\n\n')
    expect(projectTree(doc).nodes.get(ROOT_ID)!.text).toBe('Первая\nВторая\n\n')
    commands.setText(ROOT_ID, 'Первая\nВторая\n\n')
    history.undo()
    expect(projectTree(doc).nodes.get(ROOT_ID)!.text).toBe(before)
    expect(history.canUndo).toBe(false)
    history.redo()
    expect(projectTree(doc).nodes.get(ROOT_ID)!.text).toBe('Первая\nВторая\n\n')
  } finally { history.destroy(); doc.destroy() }
})

it('defaults to left without writes, validates alignment and supports first-change undo/redo without altering the tree', () => {
  const { doc, commands, history } = setup()
  const other = setup()
  try {
    const snapshot = treeSnapshot(doc)
    const vector = Y.encodeStateVector(doc)
    expect(readTextAlign(doc)).toBe('left')
    commands.setTextAlign('left')
    expect(Y.encodeStateVector(doc)).toEqual(vector)
    expect(history.canUndo).toBe(false)
    expect(() => commands.setTextAlign('right' as 'left')).toThrow('Неизвестное выравнивание')
    commands.setTextAlign('center')
    commands.setTextAlign('center')
    expect(readTextAlign(doc)).toBe('center')
    expect(readTextAlign(other.doc)).toBe('left')
    expect(history.undo()?.kind).toBe('set-text-align')
    expect(readTextAlign(doc)).toBe('left')
    expect(history.canUndo).toBe(false)
    history.redo()
    expect(readTextAlign(doc)).toBe('center')
    commands.setTextAlign('left')
    history.undo()
    expect(readTextAlign(doc)).toBe('center')
    expect(treeSnapshot(doc)).toEqual(snapshot)
    getStructures(doc).settings.set('textAlign', 'unknown')
    expect(readTextAlign(doc)).toBe('left')
  } finally { history.destroy(); doc.destroy(); other.history.destroy(); other.doc.destroy() }
})

it('stores center for a new document without changing the fallback for existing documents', () => {
  const legacy = new Y.Doc(), created = new Y.Doc()
  try {
    initializeDocument(legacy)
    initializeDocument(created, 'center')
    expect(readTextAlign(legacy)).toBe('left')
    expect(getStructures(legacy).settings.has('textAlign')).toBe(false)
    expect(readTextAlign(created)).toBe('center')
    expect(getStructures(created).settings.get('textAlign')).toBe('center')
    initializeDocument(created, 'left')
    expect(readTextAlign(created)).toBe('center')
  } finally { legacy.destroy(); created.destroy() }
})

it('converges for concurrent settings and multiline text edits in either update order', () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), (first, second) => {
    const base = setup()
    const left = cloneDocument(base.doc), right = cloneDocument(base.doc)
    const leftCommands = new TreeCommands(left), rightCommands = new TreeCommands(right)
    first.forEach(center => leftCommands.setTextAlign(center ? 'center' : 'left'))
    second.forEach(center => rightCommands.setTextAlign(center ? 'center' : 'left'))
    leftCommands.setText(ROOT_ID, 'Первая\nверсия')
    rightCommands.setText(ROOT_ID, 'Другая\nверсия')
    const ab = mergeDocuments(left, right), ba = mergeDocuments(left, right, true)
    try {
      expect(readTextAlign(ab)).toBe(readTextAlign(ba))
      expect(['left', 'center']).toContain(readTextAlign(ab))
      expect(treeSnapshot(ab)).toEqual(treeSnapshot(ba))
      expect(['Первая\nверсия', 'Другая\nверсия']).toContain(projectTree(ab).nodes.get(ROOT_ID)!.text)
    } finally { base.history.destroy(); base.doc.destroy(); left.destroy(); right.destroy(); ab.destroy(); ba.destroy() }
  }), { numRuns: 50 })
})

it('excludes remote alignment changes from history and does not undo their later value', () => {
  const { doc, commands, history } = setup()
  const remote = cloneDocument(doc)
  const remoteCommands = new TreeCommands(remote)
  const sync = () => { Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc)); Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote)) }
  try {
    commands.setTextAlign('center')
    sync()
    remoteCommands.setTextAlign('left')
    remoteCommands.setTextAlign('center')
    sync()
    history.undo()
    expect(readTextAlign(doc)).toBe('center')
    expect(history.canUndo).toBe(false)
    sync()
    expect(readTextAlign(remote)).toBe('center')
  } finally { history.destroy(); doc.destroy(); remote.destroy() }
})
