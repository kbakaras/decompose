import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { browserIdentity, normalizeName, saveIdentityName } from './identity'

export function useIdentityPrompt() {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef<((accepted: boolean) => void) | null>(null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [warning, setWarning] = useState('')
  const [error, setError] = useState('')

  const finish = useCallback((accepted = false) => {
    const resolve = pending.current
    pending.current = null
    dialog.current?.close()
    setOpen(false)
    resolve?.(accepted)
  }, [])
  const show = useCallback(() => {
    setName(browserIdentity().name ?? '')
    setError('')
    setOpen(true)
  }, [])
  const requestIdentity = useCallback((): Promise<boolean> => {
    if (browserIdentity().name) return Promise.resolve(true)
    if (pending.current) return Promise.resolve(false)
    show()
    return new Promise(resolve => { pending.current = resolve })
  }, [show])
  useLayoutEffect(() => {
    if (open) { dialog.current?.showModal(); input.current?.focus() }
  }, [open])
  useEffect(() => () => { pending.current?.(false); pending.current = null }, [])

  return {
    requestIdentity, editIdentity: show, cancelIdentity: finish,
    dialog: <>
      {open && <dialog ref={dialog} className="diagrams-dialog identity-dialog" aria-labelledby="identity-heading"
        onCancel={event => { event.preventDefault(); finish() }} onClose={() => finish()}>
        <h2 id="identity-heading">{browserIdentity().name ? 'Твоё имя' : 'Представься'}</h2>
        <p>Имя увидят другие участники. Оно сохранится в этом браузере.</p>
        <form onSubmit={event => {
          event.preventDefault()
          if (!normalizeName(name)) { setError('Введи имя длиной от 1 до 80 символов.'); return }
          const persisted = saveIdentityName(name)
          setWarning(persisted ? '' : 'Не удалось сохранить профиль в браузере. После перезагрузки придётся представиться снова.')
          finish(true)
        }}>
          <label htmlFor="identity-name">Имя</label>
          <input ref={input} id="identity-name" autoComplete="nickname" value={name}
            onChange={event => { setName(event.target.value); setError('') }} />
          {error && <p role="alert">{error}</p>}
          <div className="identity-buttons"><button type="button" onClick={() => finish()}>Отмена</button>
            <button type="submit">{browserIdentity().name ? 'Сохранить' : 'Продолжить'}</button></div>
        </form>
      </dialog>}
      {warning && <div className="notice navigation-error" role="alert"><span>{warning}</span>
        <button aria-label="Закрыть предупреждение профиля" onClick={() => setWarning('')}>×</button></div>}
    </>,
  }
}
