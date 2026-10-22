import { errMsg } from '@dsh-plugins/shared'
import { createBridgeClient } from '@dsh-plugins/shared/api'
import {
  IMPORT_PATH,
  DELETE_PATH,
  MIGRATE_PATH,
  PRESET_PATH,
  PRESETS_PATH,
  BATCH_PATH,
  MAX_ARCHIVE_BYTES,
  type BatchRequest,
  type BatchResult,
  type DeleteRequest,
  type DeleteResult,
  type ImportRequest,
  type ImportResult,
  type MigrateRequest,
  type MigrateResult,
  type PresetRequest,
  type PresetResult,
  type PresetsResult,
} from '../shared'
import type { Message } from './locales'

const api = createBridgeClient('x-dsh-sessions')
export type FileResult = { filename: string } & ({ result: ImportResult } | { error: Message })

export async function importFiles(
  files: readonly File[],
  cwd: string,
  onResult: (result: FileResult) => void,
): Promise<void> {
  for (const file of files) {
    if (file.size > MAX_ARCHIVE_BYTES) {
      onResult({ filename: file.name, error: { key: 'file.tooLarge' } })
      continue
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const parts: string[] = []
      for (let offset = 0; offset < bytes.length; offset += 32_768) {
        parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
      }
      const body: ImportRequest = { archive: btoa(parts.join('')), cwd, trusted: true }
      const result = await api.request<ImportResult>(IMPORT_PATH, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      onResult({ filename: file.name, result })
    } catch (error) {
      onResult({ filename: file.name, error: { text: errMsg(error) } })
    }
  }
}

export async function deleteSession(sessionId: string): Promise<DeleteResult> {
  const body: DeleteRequest = { sessionId }
  return api.request<DeleteResult>(DELETE_PATH, { method: 'POST', body: JSON.stringify(body) })
}

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

export async function runBatch(request: BatchRequest): Promise<BatchResult> {
  return api.request<BatchResult>(BATCH_PATH, { method: 'POST', body: JSON.stringify(request) })
}
