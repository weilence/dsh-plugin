export const IMPORT_PATH = '/dsh-sessions/import'
export const DELETE_PATH = '/dsh-sessions/delete'

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024
export const MAX_LOG_BYTES = 16 * 1024 * 1024
export const MAX_ARCHIVE_ENTRIES = 4096
export const MAX_ARCHIVE_SESSIONS = 256
export const MAX_SESSION_EVENTS = 100_000
export const MAX_REQUEST_BYTES = Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4 + 1024 * 1024

export interface ImportRequest {
  archive: string
  cwd: string
  trusted: boolean
}

export interface ImportResult {
  imported: string[]
  skipped: string[]
  incomplete: string[]
  failure?: { id?: string; reason: string }
}

export interface ArchiveExpected {
  archiveDigest: string
  cwd: string
  sessions: Record<string, string | null>
}

export interface ArchivePreview {
  expected: ArchiveExpected
}

export interface DeleteRequest {
  sessionId: string
}

export interface DeleteResult {
  filesRemoved: boolean
  archiveCleared: boolean
  archiveClearError?: string
}
