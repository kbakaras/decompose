import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './style.css'
import { Application } from './Application'
import { appBaseUrl, appUrl } from './app-url'

document.querySelector<HTMLBaseElement>('base[data-app-base]')!.href = appBaseUrl
const root = createRoot(document.getElementById('root')!)
root.render(<Application />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register(appUrl('sw.js'), { scope: appBaseUrl }).catch(console.error) })
}
