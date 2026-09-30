import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-llm/remote'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import type { ClientRemote, CredentialInfo, LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import { classifyWrite, type WriteOutcome } from '../pi-ai/ops'
import type {
  AuthDirectoryWire,
  AuthEventWire,
  AuthFlowWire,
  AuthRecordWire,
  AuthSequencedEvent,
} from '../auth'
import type { EffectiveModelFacts as EffectiveModelFactsWire } from '../effective'
import { errMsg } from '@dsh-plugins/shared'

export const PI_AI_NS = 'llm-pi-ai'
export const EFFECTIVE_PATH = '/dsh-models/effective-models'
export const AUTH_PATH = '/dsh-models/auth'
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000

export interface RouteDirectoryRow {
  provider: string
  displayName: string
  /** pi-ai 在该键下不提供任何内容 → 手工声明 route。 */
  declared: boolean
  active: boolean
  error?: string
}

/** 一个模型通过 Host 解析出的当前生效能力（只读接口的 wire 契约）。 */
export type EffectiveModelFacts = EffectiveModelFactsWire

/** 订阅登录面（host half auth 接口的 wire 契约）。 */
export type AuthFlow = AuthFlowWire
export type AuthRecord = AuthRecordWire
export type AuthEvent = AuthEventWire
export type AuthDirectory = AuthDirectoryWire
export type { AuthSequencedEvent }

export type EffectiveOutcome =
  { kind: 'found'; models: readonly EffectiveModelFacts[] } | { kind: 'unavailable'; message: string }

export interface PiAiOperations {
  loadDirectory(): Promise<RouteDirectoryRow[]>
  /**
   * 读一个 route 的安装目录模型；失败抛出携带 Host 原因的错误（面板经
   * store 的 catch 显示）。手工声明 route 没有安装目录，store 根本不发起
   * 这里的请求。
   */
  discover(provider: string): Promise<readonly LlmDiscoveredModel[]>
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
  /**
   * 读订阅登录目录（哪些 Provider 带登录 flow、凭据记录现状、是否有进行
   * 中的登录）。接口不可用（authorization 服务未挂）或不可达时返回 null——
   * 面板只是不显示登录入口，主功能不受影响。
   */
  authDirectory(): Promise<AuthDirectory | null>
  /** 发起一次订阅登录；失败抛携带 Host 原因的错误。 */
  beginAuth(provider: string): Promise<void>
  /** 拉取 after 之后的新登录事件与进行状态。 */
  authEvents(after: number): Promise<{ events: readonly AuthSequencedEvent[]; running: boolean }>
  /** 应答当前登录问题（文本 / 选项 id）或明确拒绝。 */
  answerAuth(answer: { value: string } | { declined: true }): Promise<void>
  /** 取消进行中的登录。 */
  cancelAuth(): Promise<void>
  /** 退出订阅登录：删除该 Provider 的凭据记录；失败抛携带 Host 原因的错误。 */
  revokeAuth(provider: string): Promise<void>
}

function remoteMessage(error: { message?: string } | undefined, fallback: string) {
  return error?.message || fallback
}

// 登录接口的 JSON 往返：非 2xx 时抛出服务端携带的原因。只有目录 GET 把 404
// 归为「接口不可用」（返回 null）；POST 的 404 是业务拒绝（如无登录方式），必须
// 带原因抛出。
async function authJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, ...init })
  const text = await response.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`登录接口返回了无效 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    if (response.status === 404 && init === undefined) return { absent: true }
    throw new Error(
      typeof body['error'] === 'string' ? body['error'] : `登录请求失败（HTTP ${response.status}）`,
    )
  }
  return body
}

function authRequestBody(body: Record<string, unknown>): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
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
      throw new Error(remoteMessage(response.error, '读取模型目录失败'))
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
      // 失败折叠成 undefined 是 UI 语义：凭据状态显示「未知」小圆点，不该打断面板。
      return response.ok ? response.value[ref] : undefined
    },

    async storeCredential(ref, value) {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : remoteMessage(response.error, '保存 API Key 失败')
    },

    async authDirectory() {
      try {
        const body = await authJson(AUTH_PATH)
        if ('absent' in body) return null
        const flows = body['flows']
        const records = body['records']
        if (typeof flows !== 'object' || flows === null || typeof records !== 'object' || records === null) {
          return null
        }
        const attemptRow = body['attempt']
        return {
          flows: flows as Record<string, AuthFlow>,
          records: records as Record<string, AuthRecord>,
          attempt:
            typeof attemptRow === 'object' &&
            attemptRow !== null &&
            typeof (attemptRow as { provider?: unknown }).provider === 'string'
              ? { provider: (attemptRow as { provider: string }).provider }
              : null,
        }
      } catch {
        // 可选面：接口不可达等同无登录特性，不进面板错误区。
        return null
      }
    },

    async beginAuth(provider) {
      await authJson(`${AUTH_PATH}/begin`, authRequestBody({ provider }))
    },

    async authEvents(after) {
      const body = await authJson(`${AUTH_PATH}/events?after=${encodeURIComponent(after)}`)
      const events = Array.isArray(body['events']) ? body['events'] : []
      return {
        events: events.filter(
          (event): event is AuthSequencedEvent =>
            typeof event === 'object' &&
            event !== null &&
            typeof (event as { seq?: unknown }).seq === 'number',
        ),
        running: body['running'] === true,
      }
    },

    async answerAuth(answer) {
      await authJson(
        `${AUTH_PATH}/answer`,
        authRequestBody('declined' in answer ? { declined: true } : { value: answer.value }),
      )
    },

    async cancelAuth() {
      await authJson(`${AUTH_PATH}/cancel`, authRequestBody({}))
    },

    async revokeAuth(provider) {
      await authJson(`${AUTH_PATH}/revoke`, authRequestBody({ provider }))
    },
  }
}

// 与官方 Models 页相同的规则（<ROUTE>_API_KEY）。
export function deriveKeyRef(provider: string) {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

// HTTP header 可携带的可打印 ASCII；同时拦截环境变量赋值式的粘贴。
export function validateApiKey(raw: string): string | undefined {
  const value = raw.trim()
  if (value.length === 0) return 'API Key 不能为空'
  if (!/^[\x21-\x7E]+$/.test(value)) return 'API Key 只能包含可打印 ASCII 字符；请粘贴原始密钥'
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return '这看起来是环境变量赋值；请只粘贴密钥本身'
  return undefined
}
