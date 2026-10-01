export const LIST_PATH = '/dsh-sessions/list'
export const EXPORT_PATH = '/dsh-sessions/export'
export const PREVIEW_PATH = '/dsh-sessions/preview'
export const IMPORT_PATH = '/dsh-sessions/import'
export const REMOTES_PATH = '/dsh-sessions/remotes'
export const TRANSFER_PATH = '/dsh-sessions/transfer'

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024
export const MAX_LOG_BYTES = 16 * 1024 * 1024
export const MAX_ARCHIVE_ENTRIES = 4096
export const MAX_ARCHIVE_SESSIONS = 256
export const MAX_SESSION_EVENTS = 100_000
export const MAX_REQUEST_BYTES = Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4 + 1024 * 1024

export interface ArchiveExpected {
  archiveDigest: string
  cwd: string
  sessions: Record<string, string | null>
}

export interface ArchivePreview {
  expected: ArchiveExpected
  sessions: Array<{
    id: string
    eventCount: number
    cwd?: string
    status: 'new' | 'same' | 'conflict'
  }>
  warnings: Array<'cwd-history-unchanged' | 'cold-storage-only' | 'non-atomic-tree-snapshot'>
}

export interface ImportResult {
  imported: string[]
  skipped: string[]
  incomplete: string[]
  failure?: { id?: string; reason: string }
}

export interface ExportRequest {
  id: string
}

export interface PreviewRequest {
  archive: string
  cwd: string
}

export interface ImportRequest extends PreviewRequest {
  expected: ArchiveExpected
  trusted: boolean
}

export interface SessionListItem {
  title?: string
  titleError?: string
  id: string
  cwd?: string
  eventCount?: number
  live: boolean
}

export interface TransferRequest extends PreviewRequest {
  remoteId: string
  action: 'preview' | 'import'
  expected?: ArchiveExpected
  trusted?: boolean
}

export interface ExportResponse {
  archive: string
  filename: string
}
