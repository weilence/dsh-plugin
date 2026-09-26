import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-llm/remote'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import type { ClientRemote, CredentialInfo, LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import { classifyWrite, type WriteOutcome } from '../pi-ai/ops'
import type { EffectiveModelFacts as EffectiveModelFactsWire } from '../effective'
import { errMsg } from '@dsh-plugins/shared'

export const PI_AI_NS = 'llm-pi-ai'
export const EFFECTIVE_PATH = '/dsh-models/effective-models'
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000

export interface RouteDirectoryRow {
  provider: string
  displayName: string
  /** pi-ai 在该键下不提供任何内容 → 手工声明 route。 */
  declared: boolean
  active: boolean
  error?: string
}

/** 一个模型通过 Host 解析出的当前生效能力（只读桥的 wire 契约）。 */
export type EffectiveModelFacts = EffectiveModelFactsWire

export type EffectiveOutcome =
  { kind: 'found'; models: readonly EffectiveModelFacts[] } | { kind: 'unavailable'; message: string }

export interface PiAiOperations {
  loadDirectory(): Promise<RouteDirectoryRow[]>
  /** 读一个 route 的安装目录模型；pi-ai 不提供该 route 时返回 undefined。 */
  discover(provider: string): Promise<readonly LlmDiscoveredModel[] | undefined>
  /**
   * 询问一个草稿 Endpoint 的模型清单：携带 provider 时 Host 可回读该 route
   * 已存凭据，并按协议走原生模型列表接口（openai 的 /models 等）。
   */
  discoverEndpoint(request: {
    provider?: string
    baseURL: string
    api?: string
    apiKey?: string
  }): Promise<readonly LlmDiscoveredModel[]>
  effective(provider: string): Promise<EffectiveOutcome>
  writeProfile(
    provider: string,
    profile: Record<string, unknown>,
    expectedRevision: number | undefined,
  ): Promise<WriteOutcome>
  deleteProfile(provider: string, expectedRevision: number | undefined): Promise<WriteOutcome>
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
  /** 只写存储一个凭据；返回失败信息或 undefined。 */
  storeCredential(ref: string, value: string): Promise<string | undefined>
}

function remoteMessage(error: { message?: string } | undefined, fallback: string) {
  return error?.message || fallback
}

// 刻意用结构化类型而不是 extends Context：继承官方 module augmentation 的
// 完整服务类型会与官方声明冲突，真正的绑定发生在 apply 的一次断言上。
// remote 三个命名空间的成员签名即官方 ClientRemote 的生成面。
export interface OperationsContext {
  remote: Pick<ClientRemote, 'llm' | 'credentials' | 'settings'>
  configForms: { describe(): Pick<SettingsDescribeFace, 'acceptView'> }
}

export function createOperations(ctx: OperationsContext): PiAiOperations {
  return {
    async loadDirectory() {
      const [configurable, registered] = await Promise.all([
        ctx.remote.llm.listConfigurableProviders(),
        ctx.remote.llm.listProviders(),
      ])
      if (!configurable.ok) throw new Error(remoteMessage(configurable.error, '读取 Provider 目录失败'))
      const active = new Set(registered.ok ? registered.value.map((row) => row.id) : [])
      return configurable.value.map((entry) => ({
        provider: entry.provider,
        displayName: entry.displayName,
        declared: entry.declared === true,
        active: active.has(entry.provider),
        error: entry.error,
      }))
    },

    async discover(provider) {
      const response = await ctx.remote.llm.discoverModels(PI_AI_NS, { provider })
      if (response.ok) return response.value
      // 手工声明 route 没有安装目录；这不是错误，只是没有可继承的模型。
      return undefined
    },

    async discoverEndpoint(request) {
      // 5 秒超时：同时取消 Host 请求并让 UI 准时结束等待。
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('获取模型列表超时（5 秒）'))
          controller.abort()
        }, MODEL_DISCOVERY_TIMEOUT_MS)
      })
      try {
        const response = await Promise.race([
          ctx.remote.llm.discoverModels(PI_AI_NS, request, controller.signal),
          timeout,
        ])
        if (!response.ok) throw new Error(remoteMessage(response.error, '获取模型列表失败'))
        return response.value
      } finally {
        clearTimeout(timer)
      }
    },

    async effective(provider) {
      try {
        const response = await fetch(`${EFFECTIVE_PATH}?provider=${encodeURIComponent(provider)}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        })
        const text = await response.text()
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          return {
            kind: 'unavailable',
            message: `Host 生效能力接口返回了无效 JSON（HTTP ${response.status}）`,
          }
        }
        const record = body as { models?: unknown; error?: unknown }
        if (!response.ok) {
          const message = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`
          return { kind: 'unavailable', message }
        }
        if (!Array.isArray(record.models))
          return { kind: 'unavailable', message: 'Host 生效能力接口响应缺少 models' }
        const models = record.models.flatMap((raw): EffectiveModelFacts[] => {
          if (typeof raw !== 'object' || raw === null) return []
          const item = raw as EffectiveModelFacts
          return typeof item.id === 'string' && item.id.length > 0 ? [item] : []
        })
        return { kind: 'found', models }
      } catch (error) {
        return { kind: 'unavailable', message: errMsg(error) }
      }
    },

    // 只作用 raw user 层：set ['providers', route] 整值替换，绝不重建 base、
    // 绝不触碰 llm-deepseek（与官方 Models 页同取舍）。
    async writeProfile(provider, profile, expectedRevision) {
      const response = await ctx.remote.settings.mutate(
        PI_AI_NS,
        [{ op: 'set', path: ['providers', provider], value: profile as never }],
        expectedRevision,
      )
      if (response.ok) ctx.configForms.describe().acceptView(response.value)
      return classifyWrite(response)
    },

    async deleteProfile(provider, expectedRevision) {
      const response = await ctx.remote.settings.mutate(
        PI_AI_NS,
        [{ op: 'unset', path: ['providers', provider] }],
        expectedRevision,
      )
      if (response.ok) ctx.configForms.describe().acceptView(response.value)
      return classifyWrite(response)
    },

    async describeCredential(ref) {
      const response = await ctx.remote.credentials.describe([ref])
      return response.ok ? response.value[ref] : undefined
    },

    async storeCredential(ref, value) {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : remoteMessage(response.error, '保存 API Key 失败')
    },
  }
}

// 官方 Models 页同款规则（<ROUTE>_API_KEY）。
export function deriveKeyRef(provider: string) {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

// HTTP header 可携带的可打印 ASCII；顺带拦下环境变量赋值式的粘贴。
export function validateApiKey(raw: string): string | undefined {
  const value = raw.trim()
  if (value.length === 0) return 'API Key 不能为空'
  if (!/^[\x21-\x7E]+$/.test(value)) return 'API Key 只能包含可打印 ASCII 字符；请粘贴原始密钥'
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return '这看起来是环境变量赋值；请只粘贴密钥本身'
  return undefined
}
