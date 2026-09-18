import { useCallback, useEffect, useRef, useState } from 'react'
import { App } from './App'
import { openSession, type Session } from './session'

export function Application() {
  const [header, setHeader] = useState<HTMLElement | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [switching, setSwitching] = useState(false)
  const [showLoadingNotice, setShowLoadingNotice] = useState(false)
  const [error, setError] = useState('')
  const active = useRef<Session | null>(null)
  const activeUrl = useRef(location.href)
  const beforeLeave = useRef<(() => void) | null>(null)
  const generation = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const queue = useRef(Promise.resolve())
  const noticeTimer = useRef<number | undefined>(undefined)

  const cancelNoticeTimer = useCallback(() => {
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = undefined
  }, [])

  const registerBeforeLeave = useCallback((callback: () => void) => {
    beforeLeave.current = callback
    return () => { if (beforeLeave.current === callback) beforeLeave.current = null }
  }, [])

  const navigate = useCallback((href: string, mode: 'push' | 'pop' | 'initial' = 'push'): Promise<void> => {
    const url = new URL(href, location.href)
    const id = url.searchParams.get('diagram') ?? 'main'
    const currentGeneration = ++generation.current
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    beforeLeave.current?.()
    setSwitching(true)
    cancelNoticeTimer()
    setShowLoadingNotice(false)
    if (active.current) {
      noticeTimer.current = window.setTimeout(() => {
        if (currentGeneration === generation.current) setShowLoadingNotice(true)
      }, 400)
    }
    setError('')
    const task = queue.current.catch(() => {}).then(async () => {
      if (currentGeneration !== generation.current) return
      let candidate: Session | null = null
      try {
        let closing: Promise<void> | undefined
        if (active.current?.id !== id) {
          await active.current?.flush()
          candidate = await openSession(id, controller.signal)
          // На первом открытии сохраняем возможность дождаться сервера в offline-оболочке.
          if (active.current) await candidate.whenReady(controller.signal)
          controller.signal.throwIfAborted()
          // destroy снимает presence синхронно. Публикация следующей сессии
          // и адреса выполняется в том же шаге, без окна для устаревшего перехода.
          closing = active.current?.destroy()
          active.current = candidate
          setSession(candidate)
          candidate = null
        }
        // Переходы сериализованы: запоздавшая загрузка не перезаписывает последний запрос.
        if (currentGeneration === generation.current) {
          if (mode === 'push' && location.href !== url.href) history.pushState(null, '', url)
          activeUrl.current = url.href
        }
        await closing
      } catch (failure) {
        if (candidate) await candidate.destroy().catch(console.error)
        if (currentGeneration !== generation.current || controller.signal.aborted) return
        if (mode === 'pop' && active.current) history.replaceState(null, '', activeUrl.current)
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (currentGeneration === generation.current) {
          cancelNoticeTimer()
          setShowLoadingNotice(false)
          setSwitching(false)
        }
      }
    })
    queue.current = task
    return task
  }, [cancelNoticeTimer])

  useEffect(() => {
    void navigate(location.href, 'initial')
    const popstate = () => { void navigate(location.href, 'pop') }
    window.addEventListener('popstate', popstate)
    return () => {
      window.removeEventListener('popstate', popstate)
      generation.current++
      cancelNoticeTimer()
      pending.current?.abort()
      queue.current = queue.current.catch(() => {}).then(async () => {
        const previous = active.current
        active.current = null
        await previous?.destroy()
      })
      void queue.current.catch(console.error)
    }
  }, [navigate, cancelNoticeTimer])

  return <div className="app" aria-busy={switching}>
    <header className="topbar" ref={setHeader}>
      <a href="/" className="brand" aria-label="Decompose" onClick={event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return
        event.preventDefault()
        void navigate('/')
      }}><img className="brand-mark" src="/brand/logo.png" alt="" width="28" height="28" /><span className="brand-name">decompose</span></a>
    </header>
    {session && header
      ? <App key={session.doc.clientID} session={session} header={header} switching={switching}
        navigate={navigate} registerBeforeLeave={registerBeforeLeave} />
      : <div className="loading">{error ? <a href="/" onClick={event => { event.preventDefault(); void navigate('/') }}>Вернуться к основной схеме</a> : 'Открываем Decompose…'}</div>}
    {switching && session && showLoadingNotice && <div className="navigation-notice" role="status">Открываем схему…</div>}
    {error && <div className="notice navigation-error" role="alert"><span>Не удалось открыть схему: {error}</span>
      <button aria-label="Закрыть сообщение" onClick={() => setError('')}>×</button></div>}
  </div>
}
