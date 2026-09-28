import { useMemo, useState, forwardRef, useImperativeHandle } from 'react'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { discoveredToCatalogEntry } from '../catalog/matching'
import { planProviderCreation } from '../catalog/map'
import type { ModelsDevCatalog, ModelsDevProvider } from '../catalog/types'
import type { PiAiModelEntry, PiAiProviderEntry } from '../pi-ai/types'
import { effortsLabel, type PanelRoute } from '../pi-ai/view'
import { ModelTable, TextField } from '@dsh-plugins/client-ui'
import { errMsg } from '@dsh-plugins/shared'
import styles from '@dsh-plugins/client-ui/styles'

export interface ModelsDevImportProps {
  catalog: ModelsDevCatalog | null
  loading: boolean
  error: string | null
  /** 已配置的 route：目标 ID 命中即拒绝——只能新建 Provider。 */
  routes: readonly PanelRoute[]
  busy: boolean
  onCancel(): void
  /** 获取模型：按 Endpoint + 协议 + 一次性 API Key 询问 Host 的模型清单。 */
  onFetchModels(request: {
    baseURL: string
    api: string
    apiKey?: string
  }): Promise<readonly LlmDiscoveredModel[]>
  onSaveProfile(
    provider: string,
    profile: PiAiProviderEntry,
    notice: string,
    apiKey?: string,
  ): Promise<boolean>
  onError(message: string): void
}

/** ref 面：外层新建卡片的「创建」按钮触发这里。 */
export interface ModelsDevImportHandle {
  apply(): void
}

function endpointOptions(catalog: ModelsDevCatalog | null): readonly ModelsDevProvider[] {
  return (catalog?.providers ?? []).filter(
    (provider): provider is ModelsDevProvider & { api: string } =>
      typeof provider.api === 'string' && provider.api.length > 0,
  )
}

const KNOWN_PROTOCOLS: readonly string[] = ['openai-completions', 'openai-responses', 'anthropic-messages']

function mappedProtocol(provider: ModelsDevProvider): string | undefined {
  const plan = planProviderCreation(provider)
  return plan.kind === 'custom' ? String(plan.profile['api']) : undefined
}

/** 官方 llm-pi-ai 的 route 级容量回退：列表对缺失值按这两个值兜底显示。 */
const FALLBACK_CONTEXT_WINDOW = 262_144
const FALLBACK_MAX_TOKENS = 32_768

export const ModelsDevImport = forwardRef<ModelsDevImportHandle, ModelsDevImportProps>(
  function ModelsDevImport(props, ref) {
    const [providerId, setProviderId] = useState('')
    const [displayName, setDisplayName] = useState('')
    const [apiKey, setApiKey] = useState('')
    const [endpoint, setEndpoint] = useState('')
    const [api, setApi] = useState('')
    /** null = 还没获取过；[] = 获取过但 Endpoint 没返回模型。 */
    const [models, setModels] = useState<readonly PiAiModelEntry[] | null>(null)
    const [fetching, setFetching] = useState(false)
    const [fetchError, setFetchError] = useState<string | null>(null)
    const endpointValue = endpoint.trim()
    // Endpoint 与 models.dev 某个来源的 api 完全一致 → 按「选择」处理；手动
    // 改过（或留空）就是自定义 Endpoint。导入只新建 provider，统一按来源
    // 元数据映射 api + baseURL，映射不了（unsupported）则不允许创建。
    const source = useMemo(() => {
      if (endpointValue.length === 0) return undefined
      return endpointOptions(props.catalog).find((provider) => provider.api === endpointValue)
    }, [props.catalog, endpointValue])
    const plan = useMemo(() => (source ? planProviderCreation(source) : undefined), [source])

    const target = providerId.trim()
    const existing = props.routes.some((route) => route.provider === target)
    const apiValue = api.trim()

    const fetchModels = async () => {
      if (endpointValue.length === 0) return
      setFetching(true)
      setFetchError(null)
      try {
        const protocol =
          apiValue.length > 0
            ? apiValue
            : source !== undefined && plan?.kind === 'custom'
              ? String(plan.profile['api'])
              : 'openai-completions'
        const discovered = await props.onFetchModels({
          baseURL: endpointValue,
          api: protocol,
          apiKey: apiKey.trim().length > 0 ? apiKey.trim() : undefined,
        })
        // 元数据按 matching.ts 的匹配链补全（Endpoint 来源 → 已知厂商 →
        // 全目录多数派兜底）；目录没有对应项时保留 Endpoint 返回值。
        setModels(discovered.map((model) => discoveredToCatalogEntry(props.catalog, model, source?.id)))
      } catch (error) {
        setFetchError(errMsg(error))
      } finally {
        setFetching(false)
      }
    }

    const apply = async () => {
      if (target.length === 0) {
        props.onError('新 Provider ID 不能为空')
        return
      }
      if (existing) {
        props.onError(`Provider ID「${target}」已存在；只能新建 Provider`)
        return
      }
      if (plan?.kind === 'unsupported' && apiValue.length === 0) {
        props.onError(plan.reason)
        return
      }
      const displayNameValue = displayName.trim()
      const planned: Record<string, unknown> = plan?.kind === 'custom' ? { ...plan.profile } : {}
      if (displayNameValue.length > 0) planned['displayName'] = displayNameValue
      else delete planned['displayName']
      const profile = {
        ...planned,
        baseURL: endpointValue.length > 0 ? endpointValue : undefined,
        api: apiValue.length > 0 ? apiValue : undefined,
        models: models ?? [],
      } as PiAiProviderEntry
      const ok = await props.onSaveProfile(
        target,
        profile,
        models === null || models.length === 0
          ? `已创建 Provider ${target}（模型清单为空，可展开卡片继续添加）`
          : `已创建 Provider ${target}（${models.length} 个模型）`,
        apiKey.trim().length > 0 ? apiKey.trim() : undefined,
      )
      if (ok) props.onCancel()
    }

    // 每次渲染重建 handle：apply 闭包永远读到最新 state。
    useImperativeHandle(ref, () => ({
      apply: () => {
        void apply()
      },
    }))

    const canCreate = target.length > 0 && !existing && (plan?.kind !== 'unsupported' || apiValue.length > 0)
    const canFetch = endpointValue.length > 0
    const protocolLabel = plan?.kind === 'custom' ? String(plan.profile['api']) : ''

    return (
      <>
        {props.loading && !props.catalog ? (
          <div className={styles.loading}>正在读取 Host 的 models.dev 目录…</div>
        ) : null}
        {props.error ? (
          <div className={styles.error} role="alert">
            {props.error}
          </div>
        ) : null}

        {props.catalog ? (
          <>
            <div className={styles.grid}>
              <TextField
                label="Provider"
                value={endpoint}
                placeholder="https://api.example.com/v1"
                datalist={endpointOptions(props.catalog)
                  .filter((item) => item.api !== undefined)
                  .map((item) => ({ value: item.api as string, label: item.name }))}
                onChange={(next) => {
                  setModels(null)
                  setFetchError(null)
                  setEndpoint(next)
                  // datalist 没有独立的「选中」事件，但选中建议时 onChange
                  // 会带上完整值：命中 models.dev 建议就自动带出协议。
                  const matched = endpointOptions(props.catalog).find(
                    (provider) => provider.api === next.trim(),
                  )
                  if (matched) {
                    const protocol = mappedProtocol(matched)
                    if (protocol !== undefined) setApi(protocol)
                  }
                }}
              />
              <TextField
                label="API Key（可选）"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={setApiKey}
              />
              <TextField
                label="Provider ID"
                value={providerId}
                placeholder={source?.id ?? ''}
                onChange={setProviderId}
              />
              <TextField
                label="显示名（可选；留空不写入配置）"
                value={displayName}
                onChange={setDisplayName}
              />
              <TextField
                label="API 协议（api；可留空，创建后展开卡片补全）"
                value={api}
                placeholder={protocolLabel || 'openai-completions'}
                datalist={KNOWN_PROTOCOLS.map((protocol) => ({ value: protocol }))}
                onChange={setApi}
              />
            </div>
            {existing ? (
              <div className={styles.error} role="alert">
                Provider ID「{target}」已存在；只能新建 Provider。
              </div>
            ) : plan?.kind === 'unsupported' && apiValue.length === 0 ? (
              <div className={styles.error} role="alert">
                {plan.reason}；也可在「API 协议」框手动填写后创建。
              </div>
            ) : null}
            <div className={styles.toolbar}>
              <Button
                variant="outline"
                disabled={props.busy || fetching || !canFetch}
                onClick={() => {
                  void fetchModels()
                }}
              >
                {fetching ? '获取中…' : '获取模型'}
              </Button>
              <span className={styles.footerMeta}>{models !== null ? `共 ${models.length} 个模型` : ''}</span>
            </div>
            {fetchError ? (
              <div className={styles.error} role="alert">
                {fetchError}
              </div>
            ) : null}
            <div className={styles.list}>
              {models === null ? (
                <div className={styles.empty}>模型清单为空；点「获取模型」拉取，或创建后展开卡片添加。</div>
              ) : models.length === 0 ? (
                <div className={styles.empty}>Endpoint 没有返回任何模型。</div>
              ) : (
                <ModelTable
                  rows={models.map((model) => ({
                    key: model.id,
                    name: model.name ?? model.id,
                    id: model.id,
                    ctx: model.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
                    out: model.maxTokens ?? FALLBACK_MAX_TOKENS,
                    input: model.input ?? ['text'],
                    reasoning: effortsLabel(model),
                  }))}
                />
              )}
            </div>
          </>
        ) : null}
      </>
    )
  },
)
