export const IMPORT_PATH = '/dsh-sessions/import'
export const DELETE_PATH = '/dsh-sessions/delete'
export const MIGRATE_PATH = '/dsh-sessions/migrate'

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

export interface MigrateRequest {
  sessionId: string
  workspaceId: string
}

/** 迁移停在哪个受控步骤；客户端按步骤给本地化摘要，error 保留宿主原文。 */
export type MigrateStage = 'loaded' | 'activity' | 'attach' | 'export' | 'archive' | 'delete' | 'import'

export interface MigrateSuccess {
  ok: true
  filesRemoved: boolean
  archiveClearError?: string
  /** 快路径：会话 cwd 已等于目标路径，仅补挂工作区账本，未动日志文件。 */
  attached?: true
}

export interface MigrateFailure {
  ok: false
  stage: MigrateStage
  error: string
  /** 日志已删除而导入未完成时，随响应返回导出 ZIP（Base64）与目标目录，供手动恢复导入。 */
  recoverable?: { archive: string; cwd: string }
}

export type MigrateResult = MigrateSuccess | MigrateFailure
