import * as Y from 'yjs'
import type { IndexeddbPersistence } from 'y-indexeddb'

export function flushPersistence(persistence: IndexeddbPersistence): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = persistence.db
    if (!db) { reject(new Error('Локальное хранилище недоступно')); return }
    // Readonly-транзакция ждёт завершения ранее начатых записей y-indexeddb.
    const transaction = db.transaction(Array.from(db.objectStoreNames), 'readonly')
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Не удалось сохранить схему локально'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Не удалось сохранить схему локально'))
  })
}

// При reload браузер может прервать IndexedDB-транзакцию. Временный журнал
// вкладки закрывает это окно; после подтверждённой записи он не нужен.
export async function protectPendingUpdates(id: string, doc: Y.Doc, persistence: IndexeddbPersistence) {
  const key = `decompose:pending:${id}`
  let recovered: string | null = null
  try { recovered = sessionStorage.getItem(key) }
  catch (error) { console.error('Временный журнал вкладки недоступен', error) }
  if (recovered) {
    Y.applyUpdate(doc, Uint8Array.from(atob(recovered), character => character.charCodeAt(0)))
    await flushPersistence(persistence)
    sessionStorage.removeItem(key)
  }
  let version = 0
  let pending: { version: number; update: Uint8Array }[] = []
  const changed = (update: Uint8Array, origin: unknown) => {
    if (origin === persistence) return
    const currentVersion = ++version
    pending.push({ version: currentVersion, update })
    void flushPersistence(persistence).then(() => {
      pending = pending.filter(item => item.version > currentVersion)
      if (!pending.length) sessionStorage.removeItem(key)
    }).catch(console.error)
  }
  const pagehide = () => {
    if (!pending.length) return
    try {
      const update = Y.mergeUpdates(pending.map(item => item.update))
      sessionStorage.setItem(key, btoa(Array.from(update, byte => String.fromCharCode(byte)).join('')))
    } catch (error) { console.error('Не удалось сохранить незавершённые записи перед уходом со страницы', error) }
  }
  doc.on('update', changed)
  window.addEventListener('pagehide', pagehide)
  return () => {
    doc.off('update', changed)
    window.removeEventListener('pagehide', pagehide)
  }
}
