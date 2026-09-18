import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './style.css'
import { App } from './App'
import { openSession } from './session'

const root = createRoot(document.getElementById('root')!)
root.render(<div className="loading">Открываем Decompose…</div>)
openSession().then(session => root.render(<App session={session} />)).catch(error => {
  root.render(<div className="loading" role="alert">Не удалось открыть локальное хранилище: {String(error)}</div>)
})
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(console.error) })
}
