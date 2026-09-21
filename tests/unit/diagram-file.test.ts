import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createImportedDocument, getStructures, initializeDocument, projectTree, ROOT_ID, TreeCommands } from '../../src/domain'
import { DIAGRAM_FILE_LIMIT, diagramFilename, parseDiagramFile, serializeDiagram, snapshotDiagram, validateDiagramFile } from '../../src/shared/diagram-file'
import { FileAutosave, type WritableFile } from '../../src/client/diagram-file'

it('round-trips only the visible tree, order, soft breaks, statuses and settings', () => {
  const doc = new Y.Doc(); initializeDocument(doc)
  const commands = new TreeCommands(doc)
  const a = commands.createChild(ROOT_ID, 'Первая\nстрока'), b = commands.createChild(ROOT_ID, 'Вторая')
  commands.toggleStatus(a); commands.setTrackerLink(b, 'FILE-42'); commands.move(b, a, 0); commands.setTextAlign('center')
  commands.deleteSubtree(commands.createChild(ROOT_ID, 'СЕКРЕТ: удалено'))
  const text = serializeDiagram(doc)
  expect(text).not.toMatch(/СЕКРЕТ|placement|deletions|clientID|trackerKey/)
  const restored = createImportedDocument(parseDiagramFile(text))
  const shape = (value: Y.Doc) => snapshotDiagram(value).nodes.map(node => ({ text: node.text, status: node.status,
    targetTrackerKey: node.targetTrackerKey, children: node.children.length }))
  expect(shape(restored)).toEqual(shape(doc))
  expect(snapshotDiagram(restored).settings.textAlign).toBe('center')
  expect(projectTree(restored).nodes.has(a)).toBe(false)
  doc.destroy(); restored.destroy()
})

it('validates version, settings, cycles, duplicates and size without the yEd node limit', () => {
  const nodes = Array.from({ length: 1001 }, (_, i) => ({ id: String(i), text: '', status: 'open', children: i === 0 ? Array.from({ length: 1000 }, (_, j) => String(j + 1)) : [] }))
  const file = { format: 'decompose', version: 1, nodes, settings: { textAlign: 'left' } }
  expect(validateDiagramFile(file).nodes).toHaveLength(1001)
  const imported = createImportedDocument(file, 'center')
  expect(projectTree(imported).nodes.size).toBe(1001)
  expect(snapshotDiagram(imported).settings.textAlign).toBe('left')
  imported.destroy()
  for (const invalid of [{ ...file, version: 2 }, { ...file, settings: {} }, { ...file, nodes: [...nodes, nodes[0]] },
    { ...file, nodes: [{ ...nodes[0], children: ['0'] }] }]) expect(() => validateDiagramFile(invalid)).toThrow()
  expect(() => parseDiagramFile('{')).toThrow('JSON')
  expect(() => parseDiagramFile(' '.repeat(DIAGRAM_FILE_LIMIT + 1))).toThrow('5 МиБ')
  expect(diagramFilename(' a:/b\n ')).toBe('a__b.deco')
  for (const name of ['Дерево дел', 'Дерево дел.deco', 'Дерево дел.decompose.json', 'Дерево дел.json', 'Дерево дел.DECO', 'Дерево дел.deco.deco']) {
    expect(diagramFilename(name)).toBe('Дерево дел.deco')
  }
})

function fileHandle(text: string) {
  const state = { text, fail: false, permission: 'granted' as PermissionState, writes: 0 }
  const handle: WritableFile = {
    name: 'tree.decompose.json', getFile: async () => new File([state.text], 'tree.decompose.json'),
    queryPermission: async () => state.permission, requestPermission: async () => state.permission,
    createWritable: async () => {
      let next = ''
      return { write: async value => { if (state.fail) throw new Error('Диск недоступен'); next = value }, close: async () => { state.text = next; state.writes++ }, abort: async () => {} }
    },
  }
  return { state, handle }
}

it('autosaves and refuses external changes or revoked permissions without overwriting the file', async () => {
  vi.useFakeTimers()
  const doc = new Y.Doc(); initializeDocument(doc)
  const original = serializeDiagram(doc), { state, handle } = fileHandle(original)
  const saved = vi.fn()
  const writer = new FileAutosave(handle, original, doc, () => {}, () => 7, saved)
  try {
    new TreeCommands(doc).setText(ROOT_ID, 'Автосохранение')
    await vi.advanceTimersByTimeAsync(500)
    expect(state.text).toContain('Автосохранение'); expect(writer.dirty).toBe(false); expect(saved).toHaveBeenCalledWith(7)
    state.text = 'Изменено снаружи'
    new TreeCommands(doc).setText(ROOT_ID, 'Не перезаписывать')
    await expect(writer.save()).rejects.toThrow('другой программой')
    expect(state.text).toBe('Изменено снаружи'); expect(writer.dirty).toBe(true)
    state.permission = 'denied'
    await expect(writer.retry()).rejects.toThrow('разрешения')
  } finally { writer.destroy(); doc.destroy(); vi.useRealTimers() }
})

it('serializes writes and retains updates made while a write is pending', async () => {
  const doc = new Y.Doc(); initializeDocument(doc)
  const original = serializeDiagram(doc), { state, handle } = fileHandle(original)
  let release!: () => void
  const originalCreate = handle.createWritable
  handle.createWritable = async () => { await new Promise<void>(resolve => { release = resolve }); return originalCreate() }
  const writer = new FileAutosave(handle, original, doc, () => {}, () => 0, () => {})
  try {
    getStructures(doc).nodes.get(ROOT_ID)!.set('text', 'Снимок 1')
    const first = writer.save()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    getStructures(doc).nodes.get(ROOT_ID)!.set('text', 'Снимок 2')
    handle.createWritable = originalCreate; release()
    await first
    expect(state.writes).toBe(2); expect(state.text).toContain('Снимок 2'); expect(writer.dirty).toBe(false)
    state.fail = true; new TreeCommands(doc).setText(ROOT_ID, 'Не записано')
    await expect(writer.save()).rejects.toThrow('Диск недоступен')
    expect(state.text).toContain('Снимок 2')
    state.fail = false; await writer.retry(); expect(writer.dirty).toBe(false)
  } finally { writer.destroy(); doc.destroy() }
})
