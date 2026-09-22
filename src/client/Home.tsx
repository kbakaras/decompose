import { useCallback, useEffect, useRef, useState } from 'react'
import { DiagramPicker } from './DiagramPicker'
import { FileActions, type FileActionsHandle } from './FileActions'
import { pickWritableFile } from './diagram-file'
import type { OpenLocalFile } from './file-session'
import { APP_VERSION } from './version'

export function Home({ navigate, requestIdentity, openLocal, switching }: {
  navigate: (href: string) => Promise<void>
  requestIdentity: () => Promise<boolean>
  openLocal: OpenLocalFile
  switching: boolean
}) {
  const start = useRef<HTMLButtonElement>(null)
  const files = useRef<FileActionsHandle>(null)
  const lifetime = useRef<AbortController | null>(null)
  const picking = useRef(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [error, setError] = useState<string | null>(null)
  const returnFocus = useCallback(() => {
    if (!document.querySelector('dialog[open]')) start.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    document.title = 'дерево·дел — декомпозиция задач'
    const controller = new AbortController(); lifetime.current = controller
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { controller.abort(); window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  async function openDisk() {
    if (picking.current || switching) return
    picking.current = true; setError(null)
    try {
      const { handle, text } = await pickWritableFile()
      lifetime.current?.signal.throwIfAborted()
      await openLocal(handle, text)
    } catch (error) {
      if (!lifetime.current?.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
        setError(error instanceof Error ? error.message : String(error))
      }
    } finally { picking.current = false; returnFocus() }
  }
  return <main className="home" inert={switching} aria-labelledby="home-heading">
    <div className="home-content">
      <section className="home-intro">
        <div>
          <h1 id="home-heading">Большую задачу —<br />по веточкам</h1>
          <p>дерево·дел — редактор для декомпозиции сложных задач в небольшой команде. Схема состоит из карточек, связанных в дерево.</p>
          <DiagramPicker connected={online} navigate={navigate} requestIdentity={requestIdentity} returnFocus={returnFocus}
            openFile={mode => { if (mode === 'disk') void openDisk(); else files.current?.open('new') }}
            renderTrigger={(open, expanded) => <button ref={start} className="home-start" aria-haspopup="dialog" aria-expanded={expanded}
              aria-keyshortcuts="Control+O Meta+O" onClick={open}>Начать работу <span aria-hidden="true">→</span></button>} />
        </div>
        <figure className="home-example" aria-label="Пример дерева: подготовить выпуск — уточнить задачи, проверить результат и опубликовать. Уточнение задач выполнено.">
          <div className="example-root">Подготовить выпуск</div>
          <ul><li className="example-done">Уточнить задачи</li><li>Проверить результат</li><li>Опубликовать</li></ul>
        </figure>
      </section>
      <section className="home-modes" aria-labelledby="home-modes-heading">
        <h2 id="home-modes-heading">Режимы работы</h2>
        <div className="home-mode-columns">
          <dl>
            <div><dt>Схемы</dt><dd>Для планов, вопросов и задач без ключа трекера. Схема хранится на сервере и открывается по общей ссылке.</dd></div>
            <div><dt>Задачи</dt><dd>Чаще всего дерево нужно для задачи из трекера. Открой <code>{'/tracker/{ключ}'}</code>, например <code>/tracker/MC-99636</code>. Если дерева ещё нет, оно создастся после того, как ты представишься. Тот же адрес позволит к нему вернуться. Данные из трекера не загружаются.</dd></div>
          </dl>
          <dl>
            <div><dt>Файл на диске</dt><dd>Содержимое <code>.deco</code> остаётся на твоём диске. Изменения автоматически записываются в тот же файл. Для прямой записи нужен совместимый браузер и HTTPS либо localhost.</dd></div>
            <div><dt>По ссылке</dt><dd>Владелец файла выдаёт ссылку на совместную сессию. Участники правят дерево, а файл сохраняет владелец. Когда он отключён, редактирование приостанавливается.</dd></div>
          </dl>
        </div>
        <p className="home-portability">Импорт GraphML из yEd создаёт внутреннюю схему. Любую открытую схему можно скачать в формате <code>.deco</code>.</p>
      </section>
      <section className="home-features" aria-label="Работа с деревом">
        <p>Создавай и переставляй карточки клавиатурой или мышкой. Их расположение вычисляется автоматически.</p>
        <p>Выполненные карточки помечаются зелёным. Действия можно отменять и повторять. При потере связи открытое дерево остаётся доступным.</p>
        <p>Несколько участников могут править дерево одновременно. При попытке редактировать уже занятую карточку появляется предупреждение.</p>
      </section>
      <p className="home-version">Версия <strong>{APP_VERSION}</strong></p>
    </div>
    <FileActions ref={files} returnFocus={returnFocus} reportError={setError} navigate={navigate} requestIdentity={requestIdentity} />
    {error && <div className="notice navigation-error" role="alert"><span>{error}</span><button aria-label="Закрыть сообщение файла" onClick={() => { setError(null); returnFocus() }}>×</button></div>}
  </main>
}
