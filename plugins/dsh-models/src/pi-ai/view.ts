import type { PiAiModelEntry, PiAiProviderEntry, RouteSource } from './types'
import {
  effectiveModel,
  firstString,
  providersRecordOf,
  routeCompat,
  routeModelRows,
  routeSource,
  type DiscoveredModelFacts,
  type ModelRow,
  type RouteView,
} from './profile'
import type { EffectiveModelFacts, RouteDirectoryRow } from '../client/operations'

function providerOf(root: unknown, provider: string): PiAiProviderEntry | undefined {
  return providersRecordOf(root)[provider]
}

export interface RouteInputs {
  directory: RouteDirectoryRow
  userProfile: PiAiProviderEntry | undefined
  effectiveProfile: PiAiProviderEntry | undefined
  catalog: ReadonlyMap<string, DiscoveredModelFacts>
  effective: ReadonlyMap<string, EffectiveModelFacts>
}

export interface PanelModelRow extends ModelRow {
  facts: EffectiveModelFacts | undefined
  effectiveContextWindow: number | undefined
  effectiveMaxTokens: number | undefined
  effectiveInput: readonly string[] | undefined
  effectiveEfforts: readonly string[] | undefined
  effectiveDefaultEffort: string | undefined
}

export interface PanelRoute extends RouteView {
  rows: PanelModelRow[]
}

export function buildRoute(inputs: RouteInputs): PanelRoute {
  const { directory, userProfile, effectiveProfile, catalog, effective } = inputs
  const source: RouteSource = routeSource(directory.declared, userProfile)
  const models = routeModelRows(source, userProfile, catalog)
  const routeFacts = {
    defaultContextWindow: effectiveProfile?.defaultContextWindow,
    defaultMaxTokens: effectiveProfile?.defaultMaxTokens,
  }
  return {
    provider: directory.provider,
    displayName: directory.displayName,
    declared: directory.declared,
    active: directory.active,
    configured: effectiveProfile !== undefined,
    error: directory.error,
    source,
    api: firstString(userProfile?.api, effectiveProfile?.api),
    baseURL: firstString(userProfile?.baseURL, effectiveProfile?.baseURL),
    apiKeyEnv: firstString(userProfile?.apiKeyEnv, effectiveProfile?.apiKeyEnv),
    userProfile,
    effectiveProfile,
    models,
    compat: routeCompat(userProfile, effectiveProfile),
    userCompat: routeCompat(userProfile, undefined),
    rows: models.map((row): PanelModelRow => {
      const facts = effective.get(row.id)
      return { ...row, facts, ...effectiveModelSummary(row, routeFacts, facts) }
    }),
  }
}

// 生效接口（resolveModelInfo）是请求路径看到的真值，因此优先于目录展示值。
function effectiveModelSummary(
  row: ModelRow,
  routeFacts: { defaultContextWindow?: unknown; defaultMaxTokens?: unknown },
  facts: EffectiveModelFacts | undefined,
): Omit<PanelModelRow, keyof ModelRow | 'facts'> {
  const local = effectiveModel(row, routeFacts)
  return {
    effectiveContextWindow: facts?.contextWindow ?? local.contextWindow,
    effectiveMaxTokens: facts?.defaultMaxTokens ?? local.maxTokens,
    effectiveInput: facts?.inputModalities ?? local.input,
    effectiveEfforts: facts?.reasoning?.efforts?.map((effort) => effort.id),
    effectiveDefaultEffort: facts?.reasoning?.defaultEffort,
  }
}

// configForms 快照的 scope.value 已是 resolve 后的有效 profile，scope.user
// 是原始用户层。
export function buildRoutes(
  snapshot: { value: unknown; user: unknown; base: unknown },
  directory: readonly RouteDirectoryRow[],
  catalogs: ReadonlyMap<string, ReadonlyMap<string, DiscoveredModelFacts>>,
  effective: ReadonlyMap<string, ReadonlyMap<string, EffectiveModelFacts>>,
): PanelRoute[] {
  return directory.map((row) =>
    buildRoute({
      directory: row,
      userProfile: providerOf(snapshot.user, row.provider),
      effectiveProfile: providerOf(snapshot.value, row.provider),
      catalog: catalogs.get(row.provider) ?? new Map(),
      effective: effective.get(row.provider) ?? new Map(),
    }),
  )
}

/** 草稿/清单条目的推理摘要：false = 无推理，未设置 = 默认（继承）。 */
export function effortsLabel(
  entry: PiAiModelEntry,
  t: (key: 'efforts.none' | 'efforts.default') => string,
): string {
  const efforts = entry.reasoningEfforts
  if (efforts === false) return t('efforts.none')
  if (efforts === undefined || Object.keys(efforts).length === 0) return t('efforts.default')
  return Object.keys(efforts).join('/')
}
