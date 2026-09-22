export const BACKUP_FORMAT = 'decompose-backup'
export const BACKUP_VERSION = 1
export const BACKUP_ITEM_LIMIT = 10_000
export const BACKUP_ARCHIVE_LIMIT = 512 * 1024 * 1024
export const BACKUP_EXPANDED_LIMIT = 2 * 1024 * 1024 * 1024
export const BACKUP_RESULT_LIMIT = 100

export interface BackupManifestDiagram {
  kind: 'diagram'
  id: string
  path: string
  title: string
}

export interface BackupManifestTracker {
  kind: 'tracker'
  id: string
  path: string
  title: string
  trackerKey: string
}

export type BackupManifestItem = BackupManifestDiagram | BackupManifestTracker

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  createdAt: string
  items: BackupManifestItem[]
}

export interface BackupImportFailure {
  path: string
  label: string
  reason: string
}

export interface BackupImportReplacement {
  path: string
  label: string
}

export interface BackupImportResult {
  loaded: number
  replaced: number
  failed: number
  failures: BackupImportFailure[]
  replacements: BackupImportReplacement[]
  failuresTruncated: boolean
  replacementsTruncated: boolean
}
