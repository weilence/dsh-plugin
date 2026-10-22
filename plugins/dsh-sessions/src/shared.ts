export const IMPORT_PATH = '/dsh-sessions/import'
export const DELETE_PATH = '/dsh-sessions/delete'
export const MIGRATE_PATH = '/dsh-sessions/migrate'
export const PRESET_PATH = '/dsh-sessions/preset'
export const PRESETS_PATH = '/dsh-sessions/presets'
export const BATCH_PATH = '/dsh-sessions/batch'

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024
export const MAX_LOG_BYTES = 16 * 1024 * 1024
export const MAX_ARCHIVE_ENTRIES = 4096
export const MAX_ARCHIVE_SESSIONS = 256
export const MAX_SESSION_EVENTS = 100_000
export const MAX_REQUEST_BYTES = Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4 + 1024 * 1024
export const MAX_BATCH_SESSIONS = 200

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
  /** 随主会话级联删除的子会话 id。 */
  deletedSubagents: string[]
}

export interface MigrateRequest {
  sessionId: string
  workspaceId: string
}

export interface MigrateResult {
  ok: true
  /** 是否移动了日志文件；false 表示快路径只补了工作区归属。 */
  moved: boolean
  attached: boolean
  /** 文件已迁移但归属未完成时的补救指引；宿主重启后再次迁移将走快路径。 */
  membershipPending?: string
}

export interface PresetsResult {
  presets: string[]
}

export interface PresetRequest {
  sessionId: string
  toPreset: string
}

export interface PresetResult {
  migrated: boolean
  oldPreset?: string
  newPreset: string
}

export type BatchAction = 'delete' | 'migrate' | 'preset'

export interface BatchRequest {
  action: BatchAction
  sessionIds: string[]
  payload?: { workspaceId?: string; toPreset?: string }
}

export type BatchItem =
  | { sessionId: string; ok: true; result: DeleteResult | MigrateResult | PresetResult }
  /** 删除级联去重命中：该项已随前一项主会话的删除一并移除。 */
  | { sessionId: string; ok: true; cascaded: true }
  | { sessionId: string; ok: false; error: string }

export interface BatchResult {
  items: BatchItem[]
}
