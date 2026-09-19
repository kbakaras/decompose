import { createUuid } from '../shared/uuid'
import { appBaseUrl } from './app-url'
import type { WritableFile } from './diagram-file'

export interface FileRecord {
  id: string
  handle: WritableFile
  room?: { secret: string; base: string }
}
export interface FileLease { record: FileRecord; release: () => void }
export class FileBusy extends Error {
  constructor() { super('Файл уже открыт для записи в другой вкладке. Вернись в неё или закрой её и повтори открытие.') }
}
export class FilePermission extends Error {
  constructor(readonly record: FileRecord) { super(`Разреши продолжить работу с файлом «${record.handle.name}».`) }
}

// Только дескрипторы и секрет владельца. Содержимое и CRDT-история сюда не попадают.
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('decompose-file-handles-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Не удалось запомнить выбранный файл в браузере. Проверь доступ к хранилищу сайта.'))
  })
}
async function records(): Promise<FileRecord[]> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('files').objectStore('files').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
}
export async function saveFileRecord(record: FileRecord) {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('Не удалось запомнить файл.'))
      tx.objectStore('files').put(record)
    })
  } finally { db.close() }
}
export async function findFileRecord(id: string, shared = false) {
  return (await records()).find(record => record.id === id && (!shared || record.room?.base === appBaseUrl))
}
export async function registerFile(handle: WritableFile): Promise<FileRecord> {
  if (!navigator.locks || !handle.isSameEntry) throw new Error('Браузер не поддерживает безопасное восстановление файлов и блокировку между вкладками.')
  return navigator.locks.request('decompose:file-registry', async () => {
    for (const record of await records()) {
      if (await handle.isSameEntry!(record.handle).catch(() => false)) return record
    }
    const record = { id: createUuid(), handle }
    await saveFileRecord(record)
    return record
  })
}
export async function acquireFile(record: FileRecord): Promise<FileLease> {
  if (!navigator.locks) throw new Error('Браузер не поддерживает блокировку файла между вкладками.')
  return new Promise((resolve, reject) => {
    void navigator.locks.request(`decompose:file-writer:${record.id}`, { ifAvailable: true }, async lock => {
      if (!lock) { reject(new FileBusy()); return }
      await new Promise<void>(release => resolve({ record, release }))
    }).catch(reject)
  })
}
