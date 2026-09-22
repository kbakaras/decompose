import { resolveAppUrl } from '../shared/app-base'

export function collaborationUrl(base: string | URL, endpoint = 'collaboration'): string {
  const url = resolveAppUrl(endpoint, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
