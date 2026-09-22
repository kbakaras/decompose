import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BackupImportResult } from '../shared/backup'
import { appUrl } from './app-url'

function isImportResult(value: unknown): value is BackupImportResult {
  if (!value || typeof value !== 'object') return false
  const result = value as BackupImportResult
  return [result.loaded, result.replaced, result.failed].every(number => Number.isSafeInteger(number) && number >= 0)
    && Array.isArray(result.failures) && Array.isArray(result.replacements)
    && typeof result.failuresTruncated === 'boolean' && typeof result.replacementsTruncated === 'boolean'
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string') return body.error
  } catch { /* Сервер мог вернуть ответ без JSON. */ }
  return `Сервер вернул код ${response.status}.`
}

export function BackupPage({ header, switching }: { header: HTMLElement; switching: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null)
  const statusTimer = useRef<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [showStatus, setShowStatus] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<BackupImportResult | null>(null)

  useEffect(() => {
    document.title = 'Резервное копирование — дерево·дел'
    return () => {
      controller.current?.abort()
      window.clearTimeout(statusTimer.current)
    }
  }, [])

  async function restore(file: File) {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setBusy(true); setShowStatus(false); setError(''); setResult(null)
    statusTimer.current = window.setTimeout(() => setShowStatus(true), 400)
    try {
      const response = await fetch(appUrl('api/backup'), {
        method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' }, signal: next.signal,
      })
      if (!response.ok) throw new Error(await responseError(response))
      const value: unknown = await response.json()
      if (!isImportResult(value)) throw new Error('Сервер вернул некорректный результат восстановления.')
      setResult(value)
    } catch (failure) {
      if (!next.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      window.clearTimeout(statusTimer.current)
      if (controller.current === next) {
        controller.current = null
        setBusy(false)
        setShowStatus(false)
      }
      if (input.current) input.current.value = ''
    }
  }

  return <>
    {createPortal(<p className="document-title backup-title">Резервное копирование</p>, header)}
    <main className="backup-page" inert={switching} aria-labelledby="backup-heading">
      <div className="backup-content">
        <h1 id="backup-heading">Резервное копирование</h1>
        <p className="backup-intro">Скачай все внутренние схемы и деревья задач одним архивом или восстанови их из ранее созданной копии.</p>
        <div className="backup-actions">
          <section>
            <h2>Скачать архив</h2>
            <p>В архив войдут внутренние схемы и деревья задач. Файлы на диске и совместные файловые сессии в него не входят.</p>
            <div className="backup-action-control">
              <a className="backup-button" href={appUrl('api/backup').href} download>Скачать ZIP-архив</a>
            </div>
          </section>
          <section>
            <h2>Восстановить из архива</h2>
            <p>Существующие схемы с тем же ID и деревья задач с тем же ключом будут замещены.</p>
            <input ref={input} className="sr-only" type="file" accept=".zip,application/zip"
              onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void restore(file) }} />
            <div className="backup-action-control">
              <span className="backup-progress" role="status">{busy && showStatus ? 'Восстанавливаем схемы…' : ''}</span>
              <button className="backup-button" disabled={busy} onClick={() => input.current?.click()}>Выбрать ZIP-архив</button>
            </div>
          </section>
        </div>
        {error && <div className="backup-error" role="alert"><strong>Не удалось восстановить архив</strong><span>{error}</span></div>}
        {result && <section className="backup-result" aria-labelledby="backup-result-heading">
          <h2 id="backup-result-heading">Результат восстановления</h2>
          <dl className="backup-summary">
            <div><dt>Загружено</dt><dd>{result.loaded}</dd></div>
            <div><dt>Замещено</dt><dd>{result.replaced}</dd></div>
            <div><dt>Не удалось</dt><dd>{result.failed}</dd></div>
          </dl>
          {!!result.replacements.length && <ResultList title="Замещённые схемы" items={result.replacements}
            total={result.replaced} truncated={result.replacementsTruncated} />}
          {!!result.failures.length && <ResultList title="Ошибки восстановления" items={result.failures}
            total={result.failed} truncated={result.failuresTruncated} failures />}
        </section>}
      </div>
    </main>
  </>
}

function ResultList({ title, items, total, truncated, failures = false }: {
  title: string
  items: Array<{ path: string; label: string; reason?: string }>
  total: number
  truncated: boolean
  failures?: boolean
}) {
  return <section className="backup-details">
    <h3>{title}</h3>
    <ul>{items.map(item => <li key={item.path}>
      <span><code>{item.path}</code> — {item.label}</span>
      {failures && item.reason && <small>{item.reason}</small>}
    </li>)}</ul>
    {truncated && <p>Показаны первые {items.length} из {total}.</p>}
  </section>
}
