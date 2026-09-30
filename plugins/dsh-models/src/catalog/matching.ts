import { discoveredToEntry, modelToEntry } from './map'
import type { DiscoveredModel, ModelsDevCatalog, ModelsDevModel, ModelsDevProvider } from './types'
import type { PiAiModelEntry } from '../pi-ai/types'

// pi-ai 内置 route id → models.dev provider id 的静态别名表：只收两家命名
// 不一致的（其余 id 两边同名，直接相等比较）。快照事实（pi-ai 0.85.1 ↔
// models.dev 2026-09），升级任一侧须复核；models.dev 改名只会让 ① 层静默
// 落空、由 ②③ 兜底，不报错。
const ROUTE_PROVIDER_ALIASES: Record<string, string> = {
  'zai-coding-cn': 'zai-coding-plan',
  'qwen-token-plan': 'alibaba-token-plan',
  'qwen-token-plan-cn': 'alibaba-token-plan-cn',
  // models.dev 没有 individual 变体，回落基础计划条目。
  'qwen-token-plan-individual': 'alibaba-token-plan',
  'openai-codex': 'openai',
  'kimi-coding': 'moonshotai',
  'openrouter-images': 'openrouter',
  'azure-openai-responses': 'azure',
  fireworks: 'fireworks-ai',
  together: 'togetherai',
  'vercel-ai-gateway': 'vercel',
}

// 模型 id 前缀 → 厂商本体的 models.dev 精确 id。百度 / 腾讯本体 models.dev
// 未收录，ernie / hunyuan 没有条目可指，直接走 ③ 全目录多数派。
type Preference = { pattern: RegExp; providerIds: string[] }
const PREFERENCES: Preference[] = [
  { pattern: /^gpt-(?!oss(?:-|$))|^o[134](?:-|$)/, providerIds: ['openai'] },
  { pattern: /^claude-/, providerIds: ['anthropic'] },
  { pattern: /^glm-/, providerIds: ['zai'] },
  { pattern: /^deepseek-/, providerIds: ['deepseek'] },
  { pattern: /^gemini-/, providerIds: ['google'] },
  { pattern: /^qwen(?:-|\/|\d)/, providerIds: ['alibaba'] },
  { pattern: /^(?:kimi-|moonshot-)/, providerIds: ['moonshotai'] },
  { pattern: /^doubao-/, providerIds: ['volcengine'] },
  { pattern: /^minimax-/, providerIds: ['minimax'] },
  { pattern: /^grok-/, providerIds: ['xai'] },
  { pattern: /^(?:mistral-|codestral-|pixtral-)/, providerIds: ['mistral'] },
  { pattern: /^command(?:-|$)/, providerIds: ['cohere'] },
  { pattern: /^step-/, providerIds: ['stepfun'] },
]

function providerById(catalog: ModelsDevCatalog, id: string) {
  return catalog.providers.find((provider) => provider.id === id)
}
function providerByPreference(catalog: ModelsDevCatalog, preference: Preference) {
  return catalog.providers.find((provider) => preference.providerIds.includes(provider.id))
}
function preferenceFor(id: string) {
  return PREFERENCES.find((preference) => preference.pattern.test(id.trim().toLowerCase()))
}

function exactModel(provider: ModelsDevProvider | undefined, id: string): ModelsDevModel | undefined {
  return provider?.models.find((model) => model.id.toLowerCase() === id.toLowerCase())
}

// Endpoint 偶尔在目录模型 ID 后附加 -xxxx：只认同一 Provider 内「完整已知 ID +
// 连字符」的候选并取最长，不把不同模型或纯前缀误判成同一个。
function suffixedModel(provider: ModelsDevProvider | undefined, id: string): ModelsDevModel | undefined {
  const lowerId = id.toLowerCase()
  return provider?.models.reduce<ModelsDevModel | undefined>((longest, model) => {
    const key = model.id.toLowerCase()
    if (!lowerId.startsWith(`${key}-`)) return longest
    return longest === undefined || key.length > longest.id.length ? model : longest
  }, undefined)
}

// 匹配优先级：① route 的 provider（经别名表映射到 models.dev id）内 ID 完全
// 相等（网关尾缀推断只对厂商自己的目录可信）→ ② 模型 ID 前缀定位已知厂商
// （完全相等 → -尾缀取最长）。
export function findModelMetadata(catalog: ModelsDevCatalog | null, id: string, fallbackProviderId?: string) {
  if (!catalog) return undefined
  const aliased =
    fallbackProviderId === undefined
      ? undefined
      : (ROUTE_PROVIDER_ALIASES[fallbackProviderId] ?? fallbackProviderId)
  const endpoint = aliased === undefined ? undefined : providerById(catalog, aliased)
  const endpointExact = endpoint ? exactModel(endpoint, id) : undefined
  if (endpoint && endpointExact) return { provider: endpoint, model: endpointExact }
  const preference = preferenceFor(id)
  const preferred = preference ? providerByPreference(catalog, preference) : undefined
  if (preferred) {
    const model = exactModel(preferred, id) ?? suffixedModel(preferred, id)
    if (model) return { provider: preferred, model }
  }
  return undefined
}

// 多数派取值：按 JSON 形态分组计数，票数不同取最多；同票数时 undefined 让位
// 有值者、数值按比较器取胜者、其余保持先出现者。
function majorityOf<T>(values: readonly (T | undefined)[], tieBreak?: (a: T, b: T) => number): T | undefined {
  const groups = new Map<string, { value: T | undefined; count: number }>()
  for (const value of values) {
    const key = JSON.stringify(value) ?? '∅'
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { value, count: 1 })
  }
  let best: { value: T | undefined; count: number } | undefined
  for (const group of groups.values()) {
    if (best === undefined || group.count > best.count) {
      best = group
      continue
    }
    if (group.count < best.count) continue
    if (best.value === undefined) best = group
    else if (group.value !== undefined && tieBreak !== undefined && tieBreak(group.value, best.value) > 0) {
      best = group
    }
  }
  return best === undefined ? undefined : best.value
}

// 全目录回退：同一基础 ID 被多家网关收录而容量略有出入，逐字段取出现次数
// 最多的值（contextWindow / maxTokens 同票数取较大值）。
function crossCatalogEntry(
  catalog: ModelsDevCatalog | null,
  id: string,
): Partial<PiAiModelEntry> | undefined {
  if (!catalog) return undefined
  const lowerId = id.toLowerCase()
  let family: ModelsDevModel[] = []
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (model.id.toLowerCase() === lowerId) family.push(model)
    }
  }
  if (family.length === 0) {
    let longest = -1
    for (const provider of catalog.providers) {
      for (const model of provider.models) {
        const key = model.id.toLowerCase()
        if (!lowerId.startsWith(`${key}-`)) continue
        if (key.length > longest) {
          longest = key.length
          family = [model]
        } else if (key.length === longest) {
          family.push(model)
        }
      }
    }
  }
  if (family.length === 0) return undefined
  const entries = family.map((model) => modelToEntry(model))
  const entry: Partial<PiAiModelEntry> = {}
  const name = majorityOf(entries.map((item) => item.name))
  if (name !== undefined) entry.name = name
  const contextWindow = majorityOf(
    entries.map((item) => item.contextWindow),
    (a, b) => a - b,
  )
  if (contextWindow !== undefined) entry.contextWindow = contextWindow
  const maxTokens = majorityOf(
    entries.map((item) => item.maxTokens),
    (a, b) => a - b,
  )
  if (maxTokens !== undefined) entry.maxTokens = maxTokens
  const input = majorityOf(entries.map((item) => item.input))
  if (input !== undefined) entry.input = input
  const efforts = majorityOf(entries.map((item) => item.reasoningEfforts))
  if (efforts !== undefined) entry.reasoningEfforts = efforts
  return entry
}

// 匹配顺序：① Endpoint Provider 精确 → ② 已知厂商（精确 → -尾缀）→
// ③ 全目录回退（精确 → -尾缀，多数派容量）；目录没有对应项时保留 Endpoint 返回值。
export function discoveredToCatalogEntry(
  catalog: ModelsDevCatalog | null,
  model: DiscoveredModel,
  fallbackProviderId?: string,
): PiAiModelEntry {
  const discovered = discoveredToEntry(model)
  const metadata = findModelMetadata(catalog, model.id, fallbackProviderId)
  if (metadata) return { ...discovered, ...modelToEntry(metadata.model), id: model.id }
  const family = crossCatalogEntry(catalog, model.id)
  if (family) return { ...discovered, ...family, id: model.id }
  return discovered
}

/** 新增模型自动填充的查询结果：entry 为填充候选，source 为命中的 provider id。 */
export interface ModelsDevLookup {
  entry: PiAiModelEntry
  /** 命中来源（models.dev 的 provider id）；③ 全目录多数派无单一来源。 */
  source?: string
}

// 新增模型表单的 id 查询：与「获取模型」同一条 ①②③ 匹配链，输入从 Endpoint
// 返回值换成用户手输的 id；未收录返回 undefined。
export function lookupModelEntry(
  catalog: ModelsDevCatalog | null,
  id: string,
  fallbackProviderId?: string,
): ModelsDevLookup | undefined {
  const metadata = findModelMetadata(catalog, id, fallbackProviderId)
  if (metadata) return { entry: modelToEntry(metadata.model), source: metadata.provider.id }
  const family = crossCatalogEntry(catalog, id)
  if (family === undefined) return undefined
  return { entry: { id, ...family } }
}

// 目录 route「获取模型」的来源：models.dev 该 Provider 的整份模型清单（经
// 别名表映射）。pi-ai 安装目录随包发布、滞后于 models.dev——Host 的模型发现
// 对目录 route 只会原样返回安装目录，更新的清单只能从这边拿；Provider 未
// 收录返回 undefined。
export function providerCatalogModels(
  catalog: ModelsDevCatalog | null,
  fallbackProviderId?: string,
): PiAiModelEntry[] | undefined {
  if (!catalog || fallbackProviderId === undefined) return undefined
  const aliased = ROUTE_PROVIDER_ALIASES[fallbackProviderId] ?? fallbackProviderId
  const provider = providerById(catalog, aliased)
  if (provider === undefined) return undefined
  return provider.models.map((model) => modelToEntry(model))
}
