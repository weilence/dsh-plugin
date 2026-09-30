import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm/types'
import {
  MIXED_PROTOCOL_PROVIDERS,
  type PiAiModelEntry,
  type PiAiProviderEntry,
  type RouteSource,
} from './types'
import { isRecord } from './record'
import { normalizeModelEntry } from './normalize'
import type { PanelMessage } from '../client/locales'

/** 官方模型发现结果的目录投影：目录继承比较只关心这三个字段。 */
export type DiscoveredModelFacts = Pick<LlmDiscoveredModel, 'name' | 'contextWindow' | 'maxTokens'>

// schema 默认只把 providers 写成 {}，因此 providers.<route> 存在就说明组合 base 或用户层写过它。
export function providersRecordOf(root: unknown): Record<string, PiAiProviderEntry> {
  const providers = isRecord(root) ? root['providers'] : undefined
  const result: Record<string, PiAiProviderEntry> = {}
  if (isRecord(providers)) {
    for (const [key, value] of Object.entries(providers)) {
      if (isRecord(value)) result[key] = value
    }
  }
  return result
}

export function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

export interface ModelRow {
  id: string
  /** 展示名（用户字段 → 目录名 → id）。 */
  name: string
  userEntry: PiAiModelEntry | undefined
  catalogEntry: PiAiModelEntry | undefined
  writeSite: 'models' | 'modelOverrides' | 'catalog'
}

export interface RouteView {
  provider: string
  displayName: string
  /** pi-ai 是否在该键下不提供任何内容（settings 目录的 `declared`）。 */
  declared: boolean
  /** 该 route 当前是否有活动 registration（Host 目录的 `active`）。 */
  active: boolean
  /**
   * 是否真的被配置过：官方会把整份 pi-ai 内置目录声明进可配置目录
   * （directoryEntries()），真正注册的只有 profiles() 里存在的 route；面板
   * 与官方 Models 页同规则，未配置的内置 provider 只出现在「添加 Provider」
   * 下拉里。
   */
  configured: boolean
  error?: string
  source: RouteSource
  api: string | undefined
  baseURL: string | undefined
  apiKeyEnv: string | undefined
  /** 用户层写的 profile（原始，未套 base）。 */
  userProfile: PiAiProviderEntry | undefined
  /** 合成后的有效 profile（base + user + schema 默认）。 */
  effectiveProfile: PiAiProviderEntry | undefined
  models: ModelRow[]
  compat: Record<string, unknown> | undefined
  /**
   * 用户层自己写的 compat：编辑必须以它为起点，从合成值起步会把探测默认值
   * 写成显式用户配置，之后目录升级不再生效。
   */
  userCompat: Record<string, unknown> | undefined
}

export function modelEntries(profile: PiAiProviderEntry | undefined): PiAiModelEntry[] {
  const list = profile?.models
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is PiAiModelEntry =>
      isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0,
  )
}

export function overrideEntries(profile: PiAiProviderEntry | undefined): Record<string, PiAiModelEntry> {
  const overrides = profile?.modelOverrides
  if (!isRecord(overrides)) return {}
  const result: Record<string, PiAiModelEntry> = {}
  for (const [id, value] of Object.entries(overrides)) {
    if (isRecord(value)) result[id] = value as PiAiModelEntry
  }
  return result
}

function catalogEntryOf(id: string, facts: DiscoveredModelFacts | undefined): PiAiModelEntry | undefined {
  if (facts === undefined) return undefined
  const entry: PiAiModelEntry = { id }
  if (facts.name !== undefined && facts.name !== id) entry.name = facts.name
  if (facts.contextWindow !== undefined) entry.contextWindow = facts.contextWindow
  if (facts.maxTokens !== undefined) entry.maxTokens = facts.maxTokens
  return entry
}

export function routeSource(declared: boolean, userProfile: PiAiProviderEntry | undefined): RouteSource {
  if (declared) return 'declared'
  if (modelEntries(userProfile).length > 0) return 'explicit'
  if (Object.keys(overrideEntries(userProfile)).length > 0) return 'overridden'
  return 'inherited'
}

// 显式清单/手工 route：用户层数组原样；目录 route：安装目录全集套上用户
// override，再补上 override 指定了而目录没有的模型（供修复/删除）。
export function routeModelRows(
  source: RouteSource,
  userProfile: PiAiProviderEntry | undefined,
  catalog: ReadonlyMap<string, DiscoveredModelFacts>,
): ModelRow[] {
  if (source === 'explicit' || source === 'declared') {
    return modelEntries(userProfile).map((entry) => ({
      id: entry.id,
      name: firstString(entry.name, entry.id) ?? entry.id,
      userEntry: entry,
      catalogEntry: undefined,
      writeSite: 'models' as const,
    }))
  }
  const overrides = overrideEntries(userProfile)
  const rows: ModelRow[] = []
  const seen = new Set<string>()
  for (const [id, facts] of catalog) {
    const override = overrides[id]
    rows.push({
      id,
      name: firstString(override?.name, facts.name, id) ?? id,
      userEntry: override,
      catalogEntry: catalogEntryOf(id, facts),
      writeSite: override === undefined ? 'catalog' : 'modelOverrides',
    })
    seen.add(id)
  }
  for (const [id, override] of Object.entries(overrides)) {
    if (seen.has(id)) continue
    rows.push({
      id,
      name: firstString(override.name, id) ?? id,
      userEntry: override,
      catalogEntry: undefined,
      writeSite: 'modelOverrides',
    })
  }
  return rows
}

export function effectiveModel(
  row: ModelRow,
  route: { defaultContextWindow?: unknown; defaultMaxTokens?: unknown },
): {
  contextWindow: number | undefined
  maxTokens: number | undefined
  input: readonly string[] | undefined
} {
  const contextWindow = row.userEntry?.contextWindow ?? row.catalogEntry?.contextWindow
  const maxTokens = row.userEntry?.maxTokens ?? row.catalogEntry?.maxTokens
  const input = row.userEntry?.input ?? row.catalogEntry?.input
  return {
    contextWindow:
      typeof contextWindow === 'number' ? contextWindow : toPositiveInt(route.defaultContextWindow),
    maxTokens: typeof maxTokens === 'number' ? maxTokens : toPositiveInt(route.defaultMaxTokens),
    input: Array.isArray(input) ? input : undefined,
  }
}

function toPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function routeCompat(
  userProfile: PiAiProviderEntry | undefined,
  effectiveProfile: PiAiProviderEntry | undefined,
): Record<string, unknown> | undefined {
  if (isRecord(userProfile?.compat)) return userProfile.compat as Record<string, unknown>
  if (isRecord(effectiveProfile?.compat)) return effectiveProfile.compat as Record<string, unknown>
  return undefined
}

// set 是整值替换，因此从用户层现有 profile 克隆；patch 值 undefined 表示
// 从用户层删除该字段。
export function patchUserProfile(
  userProfile: PiAiProviderEntry | undefined,
  patch: Record<string, unknown | undefined>,
): PiAiProviderEntry {
  const next: Record<string, unknown> = isRecord(userProfile) ? structuredClone(userProfile) : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = structuredClone(value)
  }
  return next as PiAiProviderEntry
}

// 官方语义「未设置的字段从同 id 目录模型取默认值」，因此只有条目明确写出
// 的字段才参与比较（条目未写出的字段等于继承）。
export function entryMatchesCatalog(
  entry: PiAiModelEntry | undefined,
  catalogEntry: PiAiModelEntry | undefined,
): boolean {
  if (entry === undefined) return true
  if (catalogEntry === undefined) return false
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'id') continue
    if (JSON.stringify(value) !== JSON.stringify((catalogEntry as Record<string, unknown>)[key])) {
      return false
    }
  }
  return true
}

export function saveModelProfile(
  source: RouteSource,
  userProfile: PiAiProviderEntry | undefined,
  row: ModelRow,
  nextEntry: PiAiModelEntry,
): PiAiProviderEntry {
  const normalized = normalizeModelEntry(nextEntry)
  if (source === 'explicit' || source === 'declared') {
    const list = modelEntries(userProfile)
    const next = list.map((entry) => (entry.id === row.id ? normalized : entry))
    return patchUserProfile(userProfile, { models: next })
  }
  const overrides = overrideEntries(userProfile)
  if (entryMatchesCatalog(normalized, row.catalogEntry)) delete overrides[row.id]
  else overrides[row.id] = normalized
  return patchUserProfile(userProfile, {
    modelOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
  })
}

export function removeModelProfile(
  source: RouteSource,
  userProfile: PiAiProviderEntry | undefined,
  row: ModelRow,
  catalog: ReadonlyMap<string, DiscoveredModelFacts>,
): PiAiProviderEntry {
  if (source === 'explicit' || source === 'declared') {
    return patchUserProfile(userProfile, {
      models: modelEntries(userProfile).filter((entry) => entry.id !== row.id),
    })
  }
  // 目录外的 override 条目只删条目本身；目录内模型的删除只能整份展开 models 把它
  // 移出 route——安装目录由 pi-ai 包提供，用户层没有可摘除的单点。
  if (!catalog.has(row.id)) {
    const overrides = overrideEntries(userProfile)
    delete overrides[row.id]
    return patchUserProfile(userProfile, {
      modelOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    })
  }
  return patchUserProfile(userProfile, {
    models: foldedCatalogModels(userProfile, catalog).filter((entry) => entry.id !== row.id),
    modelOverrides: undefined,
  })
}

// 把安装目录折叠成显式 models 清单：目录条目套上用户 override（字段级，override
// 优先），供「新增目录未描述模型」「删除目录内模型」两条必经展开的路径共用。
function foldedCatalogModels(
  userProfile: PiAiProviderEntry | undefined,
  catalog: ReadonlyMap<string, DiscoveredModelFacts>,
): PiAiModelEntry[] {
  const overrides = overrideEntries(userProfile)
  const list: PiAiModelEntry[] = []
  for (const [id, facts] of catalog) {
    const base = catalogEntryOf(id, facts) ?? { id }
    const override = overrides[id]
    list.push(normalizeModelEntry(override === undefined ? base : { ...base, ...override }))
  }
  return list
}

// modelOverrides 不能显式指定目录未描述的模型，因此必须把 models 展开为显式清单：
// 目录条目按用户 override 折叠后逐个列出，再追加新条目（触发整份展开的路径之一，
// UI 必须先警告）。
export function materializeWithNewModel(
  userProfile: PiAiProviderEntry | undefined,
  catalog: ReadonlyMap<string, DiscoveredModelFacts>,
  newEntry: PiAiModelEntry,
): PiAiProviderEntry {
  return patchUserProfile(userProfile, {
    models: [...foldedCatalogModels(userProfile, catalog), normalizeModelEntry(newEntry)],
    modelOverrides: undefined,
  })
}

export type AddModelPlan =
  | { kind: 'override'; profile: PiAiProviderEntry }
  | { kind: 'append'; profile: PiAiProviderEntry }
  /** 将整份目录展开为显式清单并追加新模型（官方 modelOverrides 不能显式指定目录未描述的模型）。 */
  | { kind: 'materialize'; profile: PiAiProviderEntry }
  | { kind: 'blocked'; reason: PanelMessage }

// 目录 route 新增目录已描述的模型只写 modelOverrides；新增目录未描述的模型
// 必须把 models 整份展开，而展开要求先能读到当前继承的完整目录，否则会把
// route 静默收窄成只有这一个模型——那种情况直接 blocked。
export function planAddModel(input: {
  source: RouteSource
  userProfile: PiAiProviderEntry | undefined
  catalog: ReadonlyMap<string, DiscoveredModelFacts>
  entry: PiAiModelEntry
}): AddModelPlan {
  const { source, userProfile, catalog, entry } = input
  if (source === 'explicit' || source === 'declared') {
    return {
      kind: 'append',
      profile: patchUserProfile(userProfile, {
        models: [...modelEntries(userProfile), entry],
        modelOverrides: undefined,
      }),
    }
  }
  if (catalog.has(entry.id)) {
    const overrides = overrideEntries(userProfile)
    overrides[entry.id] = entry
    return { kind: 'override', profile: patchUserProfile(userProfile, { modelOverrides: overrides }) }
  }
  if (catalog.size === 0) {
    return {
      kind: 'blocked',
      reason: { key: 'plan.catalogUnreadable' },
    }
  }
  return { kind: 'materialize', profile: materializeWithNewModel(userProfile, catalog, entry) }
}

/**
 * 混协议 route 上无法写入的目录外模型清单：安装目录模型协议不统一（无目录
 * 共用协议可兜底），route 又未声明 api 时，官方配置面无法为目录外模型解析
 * 协议，保存必被 Host 拒绝。可解析时返回 undefined。
 */
export function foreignModelsBlocked(input: {
  provider: string
  routeApi: string | undefined
  models: readonly PiAiModelEntry[]
  catalog: ReadonlySet<string>
}): string[] | undefined {
  if (input.routeApi !== undefined) return undefined
  if (!MIXED_PROTOCOL_PROVIDERS.includes(input.provider)) return undefined
  const foreign = input.models.filter((entry) => !input.catalog.has(entry.id)).map((entry) => entry.id)
  return foreign.length > 0 ? foreign : undefined
}
