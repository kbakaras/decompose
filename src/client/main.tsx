import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './style.css'
import { Application } from './Application'

const root = createRoot(document.getElementById('root')!)
root.render(<Application />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(console.error) })
}
