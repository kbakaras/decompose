import { resolveAppUrl } from '../shared/app-base'

export function collaborationUrl(base: string | URL): string {
  const url = resolveAppUrl('collaboration', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
