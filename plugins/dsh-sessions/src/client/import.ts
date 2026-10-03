import { errMsg } from '@dsh-plugins/shared'
import { createBridgeClient } from '@dsh-plugins/shared/api'
import { IMPORT_PATH, MAX_ARCHIVE_BYTES, type ImportRequest, type ImportResult } from '../shared'
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
