import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBackend } from '../../src/server/app'
import { DocumentHistory, ROOT_ID, SCHEMA_VERSION, TreeCommands, getStructures, projectTree } from '../../src/domain'

it('persists binary Yjs state through a full server restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-persistence-'))
  let backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  try {
    const port = await backend.listen(0)
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).toEqual({ status: 'ok' })
    const connection = await backend.collaboration.openDirectConnection('main')
    const child = new TreeCommands(connection.document!).createChild(ROOT_ID, 'Сохранить мысль')
    const hidden = new TreeCommands(connection.document!).createChild(ROOT_ID, 'Удалённая мысль')
    new TreeCommands(connection.document!).deleteSubtree(hidden)
    await connection.disconnect()
    await backend.close()
    backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
    await backend.listen(0)
    const restored = await backend.collaboration.openDirectConnection('main')
    expect(projectTree(restored.document!).nodes.get(child)?.text).toBe('Сохранить мысль')
    expect(projectTree(restored.document!).nodes.size).toBe(2)
    expect(projectTree(restored.document!).nodes.has(hidden)).toBe(false)
    await restored.disconnect()
  } finally {
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30000)

it('upgrades schema 1 without reviving legacy deletions and persists the migrated document', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decompose-migration-'))
  let backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
  try {
    await backend.listen(0)
    const connection = await backend.collaboration.openDirectConnection('main')
    const doc = connection.document!
    const commands = new TreeCommands(doc)
    const live = commands.createChild(ROOT_ID, 'Старый документ')
    const deleted = commands.createChild(ROOT_ID, 'Старое удаление')
    const { nodes, meta } = getStructures(doc)
    // Представление старой схемы: монотонный deleted и отсутствие активных маркеров.
    nodes.get(deleted)!.set('deleted', true)
    meta.set('schemaVersion', 1)
    await connection.disconnect()
    await backend.close()
    backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
    await backend.listen(0)
    const migrated = await backend.collaboration.openDirectConnection('main')
    expect(getStructures(migrated.document!).meta.get('schemaVersion')).toBe(SCHEMA_VERSION)
    expect(projectTree(migrated.document!).nodes.get(live)?.text).toBe('Старый документ')
    expect(projectTree(migrated.document!).nodes.has(deleted)).toBe(false)
    const history = new DocumentHistory(migrated.document!)
    new TreeCommands(migrated.document!).deleteSubtree(live)
    expect(projectTree(migrated.document!).nodes.has(live)).toBe(false)
    history.undo()
    expect(projectTree(migrated.document!).nodes.get(live)?.text).toBe('Старый документ')
    expect(projectTree(migrated.document!).nodes.has(deleted)).toBe(false)
    history.destroy()
    await migrated.disconnect()
    await backend.close()
    backend = createBackend({ dataDir, clientDir: resolve('dist/client') })
    await backend.listen(0)
    const persisted = await backend.collaboration.openDirectConnection('main')
    expect(getStructures(persisted.document!).meta.get('schemaVersion')).toBe(SCHEMA_VERSION)
    expect(projectTree(persisted.document!).nodes.get(live)?.text).toBe('Старый документ')
    expect(projectTree(persisted.document!).nodes.has(deleted)).toBe(false)
    await persisted.disconnect()
  } finally {
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30000)
