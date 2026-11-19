import { createBridgeClient } from '@dsh-plugins/shared/api'
import {
  MIGRATE_PATH,
  PRESET_PATH,
  PRESETS_PATH,
  type MigrateRequest,
  type MigrateResult,
  type PresetRequest,
  type PresetResult,
  type PresetsResult,
} from '../shared'

const api = createBridgeClient('x-dsh-sessions')

export async function migrateSessionToWorkspace(
  sessionId: string,
  workspaceId: string,
): Promise<MigrateResult> {
  const body: MigrateRequest = { sessionId, workspaceId }
  return api.request<MigrateResult>(MIGRATE_PATH, { method: 'POST', body: JSON.stringify(body) })
}

export async function fetchPresets(): Promise<string[]> {
  const result = await api.request<PresetsResult>(PRESETS_PATH, { method: 'POST', body: '{}' })
  return result.presets
}

export async function migrateSessionPreset(sessionId: string, toPreset: string): Promise<PresetResult> {
  const body: PresetRequest = { sessionId, toPreset }
  return api.request<PresetResult>(PRESET_PATH, { method: 'POST', body: JSON.stringify(body) })
}
