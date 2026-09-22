import { useCallback, useEffect, useRef, useState } from 'react'
import { App } from './App'
import { openSession, type Session } from './session'
import { useIdentityPrompt } from './IdentityPrompt'
import { canonicalDiagramUrl, parseDiagramRoute, type DiagramRoute } from '../shared/diagram-route'
import type { TrackerSummary } from '../shared/tracker'
import { resolveTracker, TrackerCreationCancelled, TrackerDeleted } from './tracker-catalog'
import { appBaseUrl, appUrl } from './app-url'
import { openFileSession, restoreFileSession, type OpenLocalFile } from './file-session'
import { pickWritableFile, type WritableFile } from './diagram-file'
import { FilePermission, type FileLease, type FileRecord } from './file-records'
import { Home } from './Home'
import { clearLegacyMain } from './legacy-main'
import { ActivityPage } from './ActivityPage'

function initialRouteKind() {
  try { return parseDiagramRoute(new URL(location.href), new URL(appBaseUrl)).kind } catch { return null }
}

export function Application() {
  const { requestIdentity, editIdentity, cancelIdentity, dialog } = useIdentityPrompt()
  const [header, setHeader] = useState<HTMLElement | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const initialKind = useRef(initialRouteKind())
  const [home, setHome] = useState(initialKind.current === 'home')
  const [activity, setActivity] = useState(initialKind.current === 'activity')
  const [homeVisit, setHomeVisit] = useState(0)
  const [switching, setSwitching] = useState(false)
  const [showLoadingNotice, setShowLoadingNotice] = useState(false)
  const [error, setError] = useState('')
  const [cancelledTracker, setCancelledTracker] = useState<string | null>(null)
  const [needsFile, setNeedsFile] = useState(false)
  const [fileRecovery, setFileRecovery] = useState<{ href: string; record?: FileRecord } | null>(null)
  const [deletedTracker, setDeletedTracker] = useState<{ href: string; id: string } | null>(null)
  const [leave, setLeave] = useState<(() => void) | null>(null)
  const leaveDialog = useRef<HTMLDialogElement>(null)
  const active = useRef<Session | null>(null)
  const activeUrl = useRef(location.href)
  const beforeLeave = useRef<(() => boolean) | null>(null)
  const generation = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const queue = useRef(Promise.resolve())
  const noticeTimer = useRef<number | undefined>(undefined)

  const cancelNoticeTimer = useCallback(() => {
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = undefined
  }, [])

  const registerBeforeLeave = useCallback((callback: () => boolean) => {
    beforeLeave.current = callback
    return () => { if (beforeLeave.current === callback) beforeLeave.current = null }
  }, [])

  const navigate = useCallback((href: string, mode: 'push' | 'pop' | 'initial' = 'push', force = false, local?: { handle: WritableFile; text: string; lease?: FileLease }, discard = false, recreateDeletedId?: string): Promise<void> => {
    const url = new URL(href, appBaseUrl)
    if (beforeLeave.current?.() === false) {
      local?.lease?.release()
      if (mode === 'pop') history.replaceState(null, '', activeUrl.current)
      return Promise.resolve()
    }
    const currentGeneration = ++generation.current
    cancelIdentity()
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setSwitching(true)
    cancelNoticeTimer()
    setShowLoadingNotice(false)
    if (active.current) {
      noticeTimer.current = window.setTimeout(() => {
        if (currentGeneration === generation.current) setShowLoadingNotice(true)
      }, 400)
    }
    setError('')
    setCancelledTracker(null)
    setDeletedTracker(null)
    setFileRecovery(null)
    const task = queue.current.catch(() => {}).then(async () => {
      if (currentGeneration !== generation.current) { local?.lease?.release(); return }
      let candidate: Session | null = null
      let route: DiagramRoute | undefined
      const flushPrevious = async () => {
        if (discard) return
        try { await active.current?.flush() }
        catch (error) {
          if (active.current?.file) {
            setLeave(() => () => { setLeave(null); void navigate(href, mode, force, local, true) })
            throw new Error('Не удалось сохранить файл. Можно остаться или уйти без сохранения.')
          }
          throw error
        }
      }
      try {
        route = local ? { kind: 'local-file', id: 'local' } : parseDiagramRoute(url, new URL(appBaseUrl))
        if (!local) {
          url.href = canonicalDiagramUrl(url, new URL(appBaseUrl)).href
          if (mode !== 'push' && location.href !== url.href) history.replaceState(null, '', url)
        }
        if (route.kind === 'home' || route.kind === 'activity') {
          await flushPrevious()
          controller.signal.throwIfAborted()
          const closing = active.current?.destroy()
          active.current = null; setSession(null); setNeedsFile(false)
          setHome(route.kind === 'home')
          setActivity(route.kind === 'activity')
          // На первом входе Home уже смонтирован и мог обработать choose=1.
          if (route.kind === 'home' && mode !== 'initial') setHomeVisit(value => value + 1)
          if (mode === 'push' && location.href !== url.href) history.pushState(null, '', url)
          else if (mode !== 'push') history.replaceState(null, '', url)
          activeUrl.current = url.href
          await closing
          return
        }
        let tracker: TrackerSummary | undefined
        if (route.kind === 'tracker') {
          tracker = await resolveTracker(route.key, controller.signal, requestIdentity, recreateDeletedId)
          controller.signal.throwIfAborted()
        }
        const id = route.kind !== 'tracker' ? route.id : tracker!.id
        let closing: Promise<void> | undefined
        const sameSession = active.current?.id === id && (route.kind === 'file'
          ? active.current.source === 'file' || active.current.source === 'guest'
          : route.kind === 'local-file' ? active.current.source === 'file' : active.current.source === 'system')
        if (!force && sameSession && active.current?.fileUrl) url.pathname = new URL(active.current.fileUrl).pathname
        if (force || !sameSession) {
          await flushPrevious()
          controller.signal.throwIfAborted()
          candidate = local ? await openFileSession(local.handle, local.text, controller.signal, local.lease)
            : route.kind === 'file' || route.kind === 'local-file' ? await restoreFileSession(id, route.kind === 'file', controller.signal)
              : await openSession(id, controller.signal, tracker, force)
          if (!candidate) {
            await active.current?.destroy(); active.current = null; setSession(null); setHome(false); setActivity(false); setNeedsFile(true)
            if (mode === 'push') history.pushState(null, '', url); else history.replaceState(null, '', url)
            activeUrl.current = url.href
            return
          }
          if (candidate.fileUrl) url.pathname = new URL(candidate.fileUrl).pathname
          // На первом открытии сохраняем возможность дождаться сервера в offline-оболочке.
          if (active.current) await candidate.whenReady(controller.signal)
          controller.signal.throwIfAborted()
          // destroy снимает presence синхронно. Публикация следующей сессии
          // и адреса выполняется в том же шаге, без окна для устаревшего перехода.
          closing = active.current?.destroy()
          active.current = candidate
          setSession(candidate)
          setHome(false)
          setActivity(false)
          setNeedsFile(false)
          candidate = null
        }
        // Переходы сериализованы: запоздавшая загрузка не перезаписывает последний запрос.
        if (currentGeneration === generation.current) {
          if (mode === 'push' && location.href !== url.href) history.pushState(null, '', url)
          if (mode !== 'push' && location.href !== url.href) history.replaceState(null, '', url)
          activeUrl.current = url.href
        }
        await closing
      } catch (failure) {
        if (candidate) await candidate.destroy().catch(console.error)
        if (currentGeneration !== generation.current || controller.signal.aborted) return
        if (mode === 'pop') history.replaceState(null, '', activeUrl.current)
        if (failure instanceof TrackerDeleted) {
          setDeletedTracker({ href, id: failure.id })
        } else if (failure instanceof TrackerCreationCancelled) {
          if (!active.current) setCancelledTracker(href)
        } else {
          setError(failure instanceof Error ? failure.message : String(failure))
          if (!local && (route?.kind === 'local-file' || route?.kind === 'file')) {
            setFileRecovery({ href: url.href, record: failure instanceof FilePermission ? failure.record : undefined })
            if (!active.current) setNeedsFile(true)
          }
        }
        if (local) throw failure
      } finally {
        if (local?.lease && active.current?.fileRecord !== local.lease.record) local.lease.release()
        if (currentGeneration === generation.current) {
          cancelNoticeTimer()
          setShowLoadingNotice(false)
          setSwitching(false)
        }
      }
    })
    queue.current = task
    return task
  }, [cancelNoticeTimer, cancelIdentity, requestIdentity])

  useEffect(() => { if (leave) leaveDialog.current?.showModal(); else leaveDialog.current?.close() }, [leave])
  useEffect(() => session?.subscribe(() => {
    if (session.reloadRequested) { session.reloadRequested = false; void navigate(activeUrl.current, 'initial', true) }
  }), [session, navigate])
  const openLocal: OpenLocalFile = useCallback(async (handle, text, lease) => {
    await navigate(appUrl('./').href, 'push', true, { handle, text, lease })
  }, [navigate])

  const continueFile = () => {
    if (!fileRecovery) return
    const { href, record } = fileRecovery
    const epoch = generation.current
    // requestPermission должен вызываться непосредственно из пользовательского жеста.
    const permission = record ? record.handle.requestPermission({ mode: 'readwrite' }) : Promise.resolve('granted')
    void permission.then(result => {
      if (epoch !== generation.current) return
      if (result !== 'granted') throw new Error('Нет разрешения на запись в файл.')
      return navigate(href, 'initial', true)
    }).catch(error => setError(String(error)))
  }

  useEffect(() => {
    void clearLegacyMain().catch(console.error)
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
      <a href="./" className="brand" aria-label="дерево·дел" onClick={event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return
        event.preventDefault()
        void navigate('./')
      }}><img className="brand-mark" src={appUrl('brand/logo.png').href} alt="" width="28" height="28" /><span className="brand-name">дерево·дел</span></a>
    </header>
    {session && header
      ? <App key={session.doc.clientID} session={session} header={header} switching={switching}
        navigate={navigate} openLocal={openLocal} reload={() => navigate(activeUrl.current, 'initial', true)}
        registerBeforeLeave={registerBeforeLeave} requestIdentity={requestIdentity} editIdentity={editIdentity} />
      : activity && header ? <ActivityPage header={header} navigate={navigate} switching={switching} />
      : home ? <Home key={homeVisit} navigate={navigate} requestIdentity={requestIdentity} openLocal={openLocal} switching={switching} />
      : <div className="loading">{needsFile ? <>
        <p>{fileRecovery?.record ? `Нужно разрешение на файл «${fileRecovery.record.handle.name}».` : 'Не удалось восстановить файл. Его содержимое хранится только на диске.'}</p>
        <button onClick={() => { void pickWritableFile().then(({ handle, text }) => openLocal(handle, text)).catch(error => setError(String(error))) }}>Открыть файл на диске</button>
      </> : cancelledTracker ? <>
        <p>Дерево задачи ещё не создано.</p>
        <button onClick={() => { void navigate(cancelledTracker, 'initial') }}>Создать дерево задачи</button>{' '}
      </> : !error && !deletedTracker && 'Открываем дерево·дел…'}
        {(error || cancelledTracker || deletedTracker || needsFile) && <a href="./" onClick={event => { event.preventDefault(); void navigate('./') }}>На главную</a>}
      </div>}
    {fileRecovery && <div className="notice file-recovery" role="status">
      <button disabled={switching} onClick={continueFile}>{fileRecovery.record ? 'Продолжить работу с файлом' : 'Повторить открытие'}</button>
    </div>}
    {switching && session && showLoadingNotice && <div className="navigation-notice" role="status">Открываем схему…</div>}
    {dialog}
    {deletedTracker && <div className="notice navigation-error" role="alert">
      <span>Дерево задачи удалено. Создать новое дерево с ключом в корне?</span>
      <button disabled={!navigator.onLine} onClick={() => { void navigate(deletedTracker.href, 'push', false, undefined, false, deletedTracker.id) }}>Создать новое дерево</button>
      <button onClick={() => setDeletedTracker(null)}>Закрыть</button>
    </div>}
    <dialog ref={leaveDialog} className="diagrams-dialog confirmation-dialog" aria-labelledby="leave-heading" onCancel={() => setLeave(null)}>
      <h2 id="leave-heading">Несохранённый файл</h2>
      <p>Файл не сохранён. При уходе последние изменения могут быть потеряны.</p>
      <div className="dialog-actions">
        <button className="danger-button" onClick={() => leave?.()}>Уйти без сохранения</button>
        <button onClick={() => setLeave(null)}>Остаться</button>
      </div>
    </dialog>
    {error && <div className="notice navigation-error" role="alert"><span>Не удалось открыть схему: {error}</span>
      <button aria-label="Закрыть сообщение" onClick={() => setError('')}>×</button></div>}
  </div>
}
