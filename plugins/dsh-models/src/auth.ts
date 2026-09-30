// 订阅登录接口：把宿主 authorization seam（llm-pi-ai 已为每个带登录的目录
// provider 注册 flow，如 openai-codex 的 ChatGPT 订阅 OAuth）转成面板可
// 驱动的同源 HTTP 面。GUI 里没有任何官方表面触发这些 flow，本接口是唯一入口。
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationInteraction, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import {
  credentialKey,
  credentialKeyId,
  credentialKeyScope,
  isCredentialKeySegment,
} from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'

// 凭据记录 scope = llm-pi-ai 注册名（官方 recordKeyFor 的映射事实；与 client
// half 写入的 settings namespace 同名）。有 flow 注册与否由 seam 回答，不在此假设。
const PI_AI_RECORD_SCOPE = 'llm-pi-ai'

export const AUTH_PATH = '/dsh-models/auth'
export const AUTH_BEGIN_PATH = '/dsh-models/auth/begin'
export const AUTH_EVENTS_PATH = '/dsh-models/auth/events'
export const AUTH_ANSWER_PATH = '/dsh-models/auth/answer'
export const AUTH_CANCEL_PATH = '/dsh-models/auth/cancel'
export const AUTH_REVOKE_PATH = '/dsh-models/auth/revoke'

export interface AuthFlowWire {
  label: string
  methods: readonly { id: string; label: string }[]
}

export interface AuthRecordWire {
  configured: boolean
  kind?: string
}

export interface AuthDirectoryWire {
  flows: Record<string, AuthFlowWire>
  records: Record<string, AuthRecordWire>
  /** 本插件发起、仍在进行的登录（页面刷新后据此重挂事件流）。 */
  attempt: { provider: string } | null
}

export interface AuthPromptWire {
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: readonly { id: string; label: string }[]
}

/** 登录事件流（client half 与测试消费同一契约）。 */
export type AuthEventWire =
  | { kind: 'notice'; message: string; url?: string; code?: string }
  | { kind: 'prompt'; promptId: number; prompt: AuthPromptWire }
  | { kind: 'answered'; promptId: number }
  | { kind: 'withdrawn'; promptId: number }
  | { kind: 'outcome'; status: 'authorized' | 'cancelled' | 'failed'; error?: string }

export type AuthSequencedEvent = AuthEventWire & { seq: number }

function toPromptWire(prompt: AuthorizationPrompt): AuthPromptWire {
  const base: AuthPromptWire = { kind: prompt.kind, message: prompt.message }
  if (prompt.kind !== 'select' && prompt.placeholder !== undefined) base.placeholder = prompt.placeholder
  if (prompt.kind === 'select')
    base.options = prompt.options.map((option) => ({ id: option.id, label: option.label }))
  return base
}

/**
 * 一次登录尝试的中继：flow 侧的 notify/prompt 进事件缓冲（seq 跨尝试单调
 * 递增，页面刷新后 after=0 全量重放），面板侧的应答经 answer/decline 回到
 * 挂起的 prompt promise。decline 必须用官方 AuthorizationDeclinedError——
 * seam 靠这个类把「人拒绝」结算成 cancelled 而非 failed。
 */
export class AuthAttemptRelay implements AuthorizationInteraction {
  private seq = 0
  private readonly buffer: AuthSequencedEvent[] = []
  private pending:
    | {
        promptId: number
        resolve(value: string): void
        reject(error: Error): void
        off(): void
      }
    | undefined
  private settled = false

  get running(): boolean {
    return !this.settled
  }

  private push(event: AuthEventWire) {
    this.seq += 1
    this.buffer.push({ ...event, seq: this.seq })
  }

  notify(notice: { message: string; url?: string; code?: string }): void {
    this.push({
      kind: 'notice',
      message: notice.message,
      ...(notice.url === undefined ? {} : { url: notice.url }),
      ...(notice.code === undefined ? {} : { code: notice.code }),
    })
  }

  prompt(prompt: AuthorizationPrompt): Promise<string> {
    this.seq += 1
    const promptId = this.seq
    this.buffer.push({ kind: 'prompt', promptId, prompt: toPromptWire(prompt), seq: this.seq })
    return new Promise<string>((resolve, reject) => {
      // 流程用 prompt 自带 signal 撤回问题时（浏览器回调先到，输入框作废），
      // 必须以非 Declined 错误拒绝——否则后续真实失败会被误读成人的拒绝。
      const onAbort = () => {
        if (this.pending !== entry) return
        this.pending = undefined
        this.push({ kind: 'withdrawn', promptId })
        reject(new Error('登录问题已被流程撤回'))
      }
      const entry = {
        promptId,
        resolve,
        reject,
        off: () => prompt.signal?.removeEventListener('abort', onAbort),
      }
      prompt.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending = entry
    })
  }

  /** 应答挂起的问题；没有挂起的问题时返回 false（调用方给显式 409）。 */
  answer(value: string): boolean {
    return this.finishPending((pending) => pending.resolve(value))
  }

  decline(): boolean {
    return this.finishPending((pending) => pending.reject(new AuthorizationDeclinedError()))
  }

  private finishPending(settle: (pending: NonNullable<AuthAttemptRelay['pending']>) => void): boolean {
    const pending = this.pending
    if (pending === undefined) return false
    this.pending = undefined
    pending.off()
    this.push({ kind: 'answered', promptId: pending.promptId })
    settle(pending)
    return true
  }

  /** begin 结束（成功 / 取消 / 失败）后的清理：清挂起问题、写 outcome 事件。 */
  settle(status: 'authorized' | 'cancelled' | 'failed', error?: string) {
    if (this.settled) return
    this.settled = true
    this.finishPending((pending) => pending.reject(new Error('登录已结束')))
    this.push({ kind: 'outcome', status, ...(error === undefined ? {} : { error }) })
  }

  eventsAfter(after: number): { events: readonly AuthSequencedEvent[]; running: boolean } {
    return { events: this.buffer.filter((event) => event.seq > after), running: this.running }
  }
}

function guard(
  req: IncomingMessage,
  expectedHost: string,
  method: 'GET' | 'POST',
  res: ServerResponse,
): boolean {
  if (
    !isExpectedHost(req, expectedHost) ||
    req.method !== method ||
    (method === 'POST' && !isTrustedFetch(req))
  ) {
    writeJson(res, 403, { error: 'forbidden' })
    return false
  }
  return true
}

function providerOf(body: Record<string, unknown>): string {
  const provider = body['provider']
  if (typeof provider !== 'string' || provider.length === 0) throw new HttpError(400, '缺少 provider')
  return provider
}

/**
 * 注册订阅登录接口（6 个 exact 路由）。只在 authorization 服务可用时由
 * index.ts 挂接；返回的清理函数同时撤销路由与仍在进行的登录尝试——插件的
 * interaction 回调一旦悬空，flow 会持有 key 挂起直到进程结束。
 */
export function applyAuthBridge(ctx: Context): () => void {
  let relay: AuthAttemptRelay | undefined
  let runningKey: CredentialKey | undefined
  let attemptProvider: string | undefined

  const begin = (provider: string) => {
    // 手写 route 的键不受记录语法约束（大写 / 点号），先拒绝再寻址。
    if (!isCredentialKeySegment(provider)) {
      throw new HttpError(404, `Provider「${provider}」的 ID 无法寻址凭据记录，不能订阅登录`)
    }
    const key = credentialKey(PI_AI_RECORD_SCOPE, provider)
    const entry = ctx.authorization.describe(key)
    if (entry === undefined) throw new HttpError(404, `Provider「${provider}」没有可用的登录方式`)
    if (relay?.running) throw new HttpError(409, '已有登录进行中；请先完成或取消')
    if (entry.inFlight) throw new HttpError(409, `Provider「${provider}」的登录已在其他入口进行中`)
    const next = new AuthAttemptRelay()
    relay = next
    runningKey = key
    attemptProvider = provider
    // begin 的尝试直到结束才确定结果（用户需在浏览器输码），先返回响应再让事件流接管；
    // 预检已覆盖 NO_FLOW / UNKNOWN_METHOD / ALREADY_IN_FLIGHT，异步失败
    // （流程自身错误、NOT_COMMITTED）以 outcome 事件抵达面板。
    void ctx.authorization
      .begin({ key, interaction: next })
      .then((outcome) => next.settle(outcome.status))
      .catch((error) => next.settle('failed', errMsg(error)))
  }

  const routes = [
    {
      kind: 'exact' as const,
      path: AUTH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, ctx.webServer.host, 'GET', res)) return
        try {
          const flows: Record<string, AuthFlowWire> = {}
          for (const entry of ctx.authorization.list()) {
            if (credentialKeyScope(entry.key) !== PI_AI_RECORD_SCOPE) continue
            // 只收带 oauth 方法的 flow：宿主为每个 pi-ai provider 都注册了
            // 登录（api-key 型的「登录」只是交互式问密钥），那种凭据面板的
            // API Key 字段已经覆盖，进 flows 反而会把普通 provider 误标成
            // 订阅型。
            const methods = entry.methods.map((method) => ({ id: method.id, label: method.label }))
            if (!methods.some((method) => method.id === 'oauth')) continue
            flows[credentialKeyId(entry.key)] = { label: entry.label, methods }
          }
          const records: Record<string, AuthRecordWire> = {}
          const credentials = ctx.get('credentials')
          if (credentials !== undefined) {
            for (const provider of Object.keys(flows)) {
              const info = await credentials.describeRecord(credentialKey(PI_AI_RECORD_SCOPE, provider))
              records[provider] = {
                configured: info.configured,
                ...(info.kind === undefined ? {} : { kind: info.kind }),
              }
            }
          }
          const body: AuthDirectoryWire = {
            flows,
            records,
            attempt:
              relay !== undefined && relay.running && attemptProvider !== undefined
                ? { provider: attemptProvider }
                : null,
          }
          writeJson(res, 200, body as unknown as Record<string, unknown>)
        } catch (error) {
          writeJson(res, 500, { error: errMsg(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: AUTH_BEGIN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, ctx.webServer.host, 'POST', res)) return
        try {
          begin(providerOf(await readJsonBody(req)))
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: AUTH_EVENTS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, ctx.webServer.host, 'GET', res)) return
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const after = Number(url.searchParams.get('after') ?? '0')
          const outcome =
            relay === undefined
              ? { events: [], running: false }
              : relay.eventsAfter(Number.isSafeInteger(after) && after >= 0 ? after : 0)
          writeJson(res, 200, outcome as unknown as Record<string, unknown>)
        } catch (error) {
          writeJson(res, 500, { error: errMsg(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: AUTH_ANSWER_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, ctx.webServer.host, 'POST', res)) return
        try {
          const body = await readJsonBody(req)
          // 空字符串是合法应答（copilot flow 的「Enterprise URL，空 =
          // github.com」），只有缺 value 字段才算请求形状错误。
          const answered =
            body['declined'] === true
              ? relay?.decline()
              : typeof body['value'] === 'string'
                ? relay?.answer(body['value'])
                : undefined
          if (answered === undefined) throw new HttpError(400, '应答必须是 { value } 或 { declined: true }')
          if (answered === false) throw new HttpError(409, '当前没有待应答的登录问题')
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: AUTH_CANCEL_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, ctx.webServer.host, 'POST', res)) return
        try {
          if (relay !== undefined && relay.running && runningKey !== undefined)
            ctx.authorization.cancel(runningKey)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 500, { error: errMsg(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: AUTH_REVOKE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, ctx.webServer.host, 'POST', res)) return
        try {
          const provider = providerOf(await readJsonBody(req))
          // 手写 route 的键不受记录语法约束（大写 / 点号），先拒绝再寻址。
          if (!isCredentialKeySegment(provider)) {
            throw new HttpError(404, `Provider「${provider}」的 ID 无法寻址凭据记录，不能退出登录`)
          }
          const key = credentialKey(PI_AI_RECORD_SCOPE, provider)
          // 删除记录撤不回进行中的 flow，它结束时还会提交新记录——「退出后又
          // 自动登录」，因此先要求完成或取消。
          if (ctx.authorization.describe(key)?.inFlight) {
            throw new HttpError(409, `Provider「${provider}」的登录正在进行中；请先完成或取消`)
          }
          const credentials = ctx.get('credentials')
          if (credentials === undefined) throw new HttpError(500, '凭据服务不可用，无法删除登录记录')
          await credentials.deleteRecord(key)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
        }
      },
    },
  ]

  const disposers = routes.map((route) => ctx.webServer.register(route))
  disposers.push(() => {
    if (relay !== undefined && relay.running && runningKey !== undefined) ctx.authorization.cancel(runningKey)
  })
  return () => disposers.forEach((dispose) => dispose())
}
