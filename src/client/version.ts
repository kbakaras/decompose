export function normalizeAppVersion(value: string | undefined): string {
  return value?.trim() || 'local'
}

export const APP_VERSION = normalizeAppVersion(import.meta.env.VITE_APP_VERSION)
