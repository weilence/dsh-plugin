export const MIGRATE_PATH = '/dsh-sessions/migrate'
export const PRESET_PATH = '/dsh-sessions/preset'
export const PRESETS_PATH = '/dsh-sessions/presets'

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
