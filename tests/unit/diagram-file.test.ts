import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { applyExternalSnapshot, createImportedDocument, getStructures, initializeDocument, projectTree, ROOT_ID, TreeCommands } from '../../src/domain'
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
  expect(projectTree(restored).nodes.has(a)).toBe(true)
  doc.destroy(); restored.destroy()
})

it('validates version, settings, cycles, duplicates and size without the yEd node limit', () => {
  const nodes = Array.from({ length: 1001 }, (_, i) => ({ id: i === 0 ? 'root' : String(i), text: '', status: 'open', children: i === 0 ? Array.from({ length: 1000 }, (_, j) => String(j + 1)) : [] }))
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

it('applies an external snapshot by stable IDs and clears removed history from the visible document', () => {
  const doc = new Y.Doc(); initializeDocument(doc, 'left')
  const commands = new TreeCommands(doc)
  const kept = commands.createChild(ROOT_ID, 'Сохранить ID')
  const moved = commands.createChild(kept, 'Сменить родителя')
  const removed = commands.createChild(ROOT_ID, 'Удалить')
  const added = '3e11f7df-d63d-4b75-bf5a-6c6b7e691758'
  const beforePlacement = projectTree(doc).nodes.get(kept)!.placementId
  const beforeMovedPlacement = projectTree(doc).nodes.get(moved)!.placementId
  applyExternalSnapshot(doc, { format: 'decompose', version: 1, nodes: [
    { id: 'root', text: 'Внешний корень', status: 'open', children: [added, kept, moved] },
    { id: added, text: 'Добавлен', status: 'done', children: [] },
    { id: kept, text: 'Изменён', status: 'open', children: [] },
    { id: moved, text: 'Перемещён', status: 'done', targetTrackerKey: 'FILE-42', children: [] },
  ], settings: { textAlign: 'center' } })
  const tree = projectTree(doc)
  expect([...tree.nodes.keys()]).toEqual(['root', kept, moved, added])
  expect(tree.children.get(ROOT_ID)).toEqual([added, kept, moved])
  expect(tree.nodes.get(kept)?.text).toBe('Изменён')
  expect(tree.nodes.get(kept)?.placementId).toBe(beforePlacement)
  expect(tree.nodes.get(moved)?.placementId).not.toBe(beforeMovedPlacement)
  expect(tree.nodes.get(moved)?.targetTrackerKey).toBe('FILE-42')
  expect(tree.nodes.has(removed)).toBe(false)
  expect(snapshotDiagram(doc).settings.textAlign).toBe('center')
  doc.destroy()
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
    state.permission = 'denied'
    new TreeCommands(doc).setText(ROOT_ID, 'Нет разрешения')
    await expect(writer.retry()).rejects.toThrow('разрешения')
    state.permission = 'granted'; await writer.retry()
    state.text = 'Изменено снаружи'
    new TreeCommands(doc).setText(ROOT_ID, 'Не перезаписывать')
    await expect(writer.save()).rejects.toThrow('нельзя прочитать')
    expect(state.text).toBe('Изменено снаружи'); expect(writer.dirty).toBe(true)
  } finally { writer.destroy(); doc.destroy(); vi.useRealTimers() }
})

it('observes a clean external snapshot, preserves its IDs and ignores formatting-only rewrites', async () => {
  const doc = new Y.Doc(); initializeDocument(doc)
  const original = serializeDiagram(doc), { state, handle } = fileHandle(original)
  const cleared = vi.fn()
  const writer = new FileAutosave(handle, original, doc, () => {}, () => 0, () => {})
  writer.configure({ clearHistory: cleared })
  try {
    const child = '76af0095-197c-4db4-a488-b64e53e423bb'
    state.text = JSON.stringify({ format: 'decompose', version: 1, nodes: [
      { id: 'root', text: 'Из внешнего файла', status: 'open', children: [child] },
      { id: child, text: 'Новая карточка', status: 'done', children: [] },
    ], settings: { textAlign: 'center' } })
    await writer.checkExternal()
    expect(projectTree(doc).nodes.get(child)?.text).toBe('Новая карточка')
    expect(projectTree(doc).nodes.get(ROOT_ID)?.text).toBe('Из внешнего файла')
    expect(cleared).toHaveBeenCalledOnce()
    expect(state.writes).toBe(0)

    state.text = JSON.stringify(JSON.parse(state.text), null, 4)
    await writer.checkExternal()
    expect(cleared).toHaveBeenCalledOnce()
    new TreeCommands(doc).setText(ROOT_ID, 'После форматирования')
    await writer.save()
    expect(state.text).toContain('После форматирования')
  } finally { writer.destroy(); doc.destroy() }
})

it('stops on concurrent disk and document changes and resolves the conflict explicitly', async () => {
  const doc = new Y.Doc(); initializeDocument(doc)
  const original = serializeDiagram(doc), { state, handle } = fileHandle(original)
  const conflictChanged = vi.fn()
  const writer = new FileAutosave(handle, original, doc, () => {}, () => 0, () => {})
  writer.configure({ conflictChanged })
  try {
    const external = { format: 'decompose', version: 1, nodes: [
      { id: 'root', text: 'Внешняя версия', status: 'open', children: [] },
    ], settings: { textAlign: 'center' } }
    state.text = JSON.stringify(external)
    new TreeCommands(doc).setText(ROOT_ID, 'Локальная версия')
    await writer.checkExternal()
    expect(writer.conflict?.external).toEqual(external)
    expect(projectTree(doc).nodes.get(ROOT_ID)?.text).toBe('Локальная версия')
    await writer.acceptExternal()
    expect(projectTree(doc).nodes.get(ROOT_ID)?.text).toBe('Внешняя версия')
    expect(writer.conflict).toBeUndefined()
    expect(conflictChanged).toHaveBeenLastCalledWith(undefined)
  } finally { writer.destroy(); doc.destroy() }
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
