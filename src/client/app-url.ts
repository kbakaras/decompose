import { resolveAppUrl } from '../shared/app-base'

// Снимок делается до первого pushState, независимо от начального SPA-маршрута.
export const appBaseUrl = document.baseURI
export const appUrl = (path: string) => resolveAppUrl(path, appBaseUrl)
