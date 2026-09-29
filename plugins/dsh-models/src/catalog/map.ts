import type { ModelsDevModel, ModelsDevProvider } from './types'
import type { PiAiModelEntry, PiAiModality } from '../pi-ai/types'

const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function inputModalities(model: ModelsDevModel): PiAiModality[] {
  const result: PiAiModality[] = []
  if (model.modalities.input.includes('text')) result.push('text')
  if (model.modalities.input.includes('image')) result.push('image')
  return result
}

// reasoning_options[type=effort] → 官方 reasoningEfforts：none/off 映射为
// `off: null`（支持该等级但不发送参数），未知等级不提供，映射不了返回 undefined。
export function reasoningEffortsOf(model: ModelsDevModel): PiAiModelEntry['reasoningEfforts'] {
  if (!model.reasoning) return false
  const option = model.reasoningOptions.find((candidate) => candidate.type === 'effort')
  if (!option || !Array.isArray(option.values)) return undefined
  const mapped: Record<string, string | null> = {}
  for (const raw of option.values) {
    if (typeof raw !== 'string') continue
    const value = raw.trim().toLowerCase()
    if (value === 'none' || value === 'off') mapped.off = null
    else if (EFFORT_LEVELS.has(value)) mapped[value] = value
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined
}

// 只映射官方语义明确的字段：`toggle`/`budget_tokens` 无通用安全映射、
// `decision` 类型始终排除。
export function modelToEntry(model: ModelsDevModel): PiAiModelEntry {
  const entry: PiAiModelEntry = { id: model.id }
  if (model.name && model.name !== model.id) entry.name = model.name
  if (model.limit.context !== undefined) entry.contextWindow = model.limit.context
  if (model.limit.output !== undefined) entry.maxTokens = model.limit.output
  const input = inputModalities(model)
  if (input.length > 0) entry.input = input
  const efforts = reasoningEffortsOf(model)
  if (efforts !== undefined) entry.reasoningEfforts = efforts
  return entry
}

export function discoveredToEntry(model: {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}): PiAiModelEntry {
  const entry: PiAiModelEntry = { id: model.id }
  if (model.name && model.name !== model.id) entry.name = model.name
  if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow
  if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens
  return entry
}

export type ProviderCreation =
  { kind: 'custom'; profile: Record<string, unknown> } | { kind: 'unsupported'; reason: string }

// 只有 openai-compatible / anthropic SDK 能按元数据安全映射 api + baseURL，
// 其余交回用户。
export function planProviderCreation(provider: ModelsDevProvider): ProviderCreation {
  if (!provider.api) {
    return {
      kind: 'unsupported',
      reason: 'models.dev 未提供 API Endpoint，且 pi-ai 没有该 Provider 的内置目录',
    }
  }
  if (provider.npm === '@ai-sdk/openai-compatible') {
    return {
      kind: 'custom',
      profile: { displayName: provider.name, api: 'openai-completions', baseURL: provider.api },
    }
  }
  if (provider.npm === '@ai-sdk/anthropic') {
    return {
      kind: 'custom',
      profile: { displayName: provider.name, api: 'anthropic-messages', baseURL: provider.api },
    }
  }
  return {
    kind: 'unsupported',
    reason: `无法把 ${provider.npm ?? '未知 SDK'} 安全映射为 pi-ai 协议`,
  }
}
