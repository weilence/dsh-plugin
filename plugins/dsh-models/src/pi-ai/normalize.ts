import type { PiAiModelEntry } from './types'
import { isRecord } from './record'
import { normalizeReasoningEfforts } from './validate'

// 只写用户真正编辑过的字段并按官方字段顺序排列，避免 schema 默认值被写进
// 用户配置；面板不认识的既有字段原样保留（未展示的现有字段编辑后仍会保留，
// 与官方 Models 页的取舍一致）。
export function normalizeModelEntry(entry: PiAiModelEntry): PiAiModelEntry {
  const result: Record<string, unknown> = {}
  if (entry.id) result.id = entry.id
  if (typeof entry.name === 'string' && entry.name.length > 0) result.name = entry.name
  if (entry.contextWindow !== undefined) result.contextWindow = entry.contextWindow
  if (entry.maxTokens !== undefined) result.maxTokens = entry.maxTokens
  if (Array.isArray(entry.input) && entry.input.length > 0) result.input = [...entry.input]
  const efforts = normalizeReasoningEfforts(entry.reasoningEfforts)
  if (efforts !== undefined) result.reasoningEfforts = efforts
  if (isRecord(entry.compat) && Object.keys(entry.compat).length > 0)
    result.compat = structuredClone(entry.compat)
  for (const [key, value] of Object.entries(entry)) {
    if (key in result) continue
    if (value === undefined) continue
    result[key] = structuredClone(value)
  }
  return result as PiAiModelEntry
}
