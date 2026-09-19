import type { Session } from './session'

export function FileIndicator({ session }: { session: Session }) {
  if (session.source === 'system') return null
  const file = session.file
  const mode = file ? 'Файл на диске' : 'По ссылке'
  const fileName = file?.handle.name || session.fileName
  const state = file?.error ? 'error' : file?.saving || file?.dirty ? 'saving' : 'saved'
  const status = file
    ? state === 'error' ? 'Не сохранено' : state === 'saving' ? 'Сохраняем…' : 'Сохранено'
    : session.waitingForOwner ? 'Ожидаем владельца файла' : session.ended ? 'Подключение завершено' : !session.canEdit ? 'Только просмотр' : 'Сохраняет владелец'
  const description = [mode, fileName, status].filter(Boolean).join(' — ')

  return <span className="file-indicator" data-state={file ? state : 'guest'} role="status" aria-label={description} title={description}>
    <strong className="file-mode">{mode}</strong>
    {fileName && <span className="file-name">{fileName}</span>}
    <span className="file-save-state">{status}</span>
    <span className="file-menu-arrow" aria-hidden="true">▾</span>
  </span>
}
