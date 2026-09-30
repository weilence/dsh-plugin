import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

export const CODEX_CREDENTIAL_KEY = credentialKey('llm-pi-ai', 'openai-codex')
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const REFRESH_MARGIN_MS = 5 * 60_000

export interface CodexQuotaWindow {
  bucketId?: string
  bucketName?: string
  kind: 'primary' | 'secondary'
  usedPct: number
  resetMs: number
  windowMins?: number
}

export interface CodexQuota {
  windows: CodexQuotaWindow[]
}

export type CodexQuotaErrorCode =
  | 'not_signed_in'
  | 'credential_error'
  | 'refresh_error'
  | 'timeout'
  | 'http_error'
  | 'request_error'
  | 'invalid_wire'

export class CodexQuotaError extends Error {
  constructor(
    readonly code: CodexQuotaErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CodexQuotaError'
  }
}

export interface CodexQuotaOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  maxBodyBytes?: number
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(detail: string): never {
  throw new CodexQuotaError('invalid_wire', `ChatGPT 配额响应无效：${detail}`)
}

function oauthPayload(value: unknown): {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
} {
  if (!object(value) || value.type !== 'oauth') invalid('凭据不是 Codex OAuth grant')
  if (typeof value.access !== 'string' || !value.access) invalid('OAuth access 无效')
  if (typeof value.refresh !== 'string' || !value.refresh) invalid('OAuth refresh 无效')
  if (typeof value.expires !== 'number' || !Number.isSafeInteger(value.expires) || value.expires < 0) {
    invalid('OAuth expires 无效')
  }
  if (typeof value.accountId !== 'string' || !value.accountId) invalid('OAuth accountId 无效')
  return {
    type: 'oauth',
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
    accountId: value.accountId,
  }
}

function parseWindow(
  value: unknown,
  kind: 'primary' | 'secondary',
  bucketId: string,
  bucketName: string | undefined,
): CodexQuotaWindow | undefined {
  if (value === null || value === undefined) return undefined
  if (!object(value)) invalid(`${kind} 窗口不是对象`)
  const {
    used_percent: used,
    reset_at: reset,
    limit_window_seconds: duration,
    reset_after_seconds: after,
  } = value
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) {
    invalid(`${kind}.used_percent 无效`)
  }
  if (typeof reset !== 'number' || !Number.isSafeInteger(reset) || reset < 0) {
    invalid(`${kind}.reset_at 无效`)
  }
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0) {
    invalid(`${kind}.limit_window_seconds 无效`)
  }
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
    invalid(`${kind}.reset_after_seconds 无效`)
  }
  const resetMs = reset * 1000
  if (!Number.isSafeInteger(resetMs)) invalid(`${kind}.reset_at 超出毫秒时间戳范围`)
  return {
    bucketId,
    ...(bucketName === undefined ? {} : { bucketName }),
    kind,
    usedPct: used,
    resetMs,
    windowMins: duration / 60,
  }
}

function parseBucket(value: unknown, bucketId: string, bucketName?: string): CodexQuotaWindow[] {
  if (!object(value)) invalid('rate_limit 不是对象')
  const windows: CodexQuotaWindow[] = []
  for (const [field, kind] of [
    ['primary_window', 'primary'],
    ['secondary_window', 'secondary'],
  ] as const) {
    const window = parseWindow(value[field], kind, bucketId, bucketName)
    if (window !== undefined) windows.push(window)
  }
  return windows
}

function parseUsage(value: unknown): CodexQuota {
  if (!object(value) || typeof value.plan_type !== 'string' || !value.plan_type) {
    invalid('plan_type 无效')
  }
  const windows: CodexQuotaWindow[] = []
  if (value.rate_limit != null) windows.push(...parseBucket(value.rate_limit, 'codex', 'Codex'))
  if (value.additional_rate_limits != null) {
    if (!Array.isArray(value.additional_rate_limits)) invalid('additional_rate_limits 不是数组')
    const ids = new Set(['codex'])
    for (const entry of value.additional_rate_limits) {
      if (!object(entry) || typeof entry.limit_name !== 'string' || !entry.limit_name) {
        invalid('additional_rate_limits.limit_name 无效')
      }
      if (typeof entry.metered_feature !== 'string' || !entry.metered_feature) {
        invalid('additional_rate_limits.metered_feature 无效')
      }
      if (ids.has(entry.metered_feature)) invalid('additional_rate_limits 桶 ID 重复')
      ids.add(entry.metered_feature)
      if (entry.rate_limit != null) {
        windows.push(...parseBucket(entry.rate_limit, entry.metered_feature, entry.limit_name))
      }
    }
  }
  if (!windows.length) invalid('没有可展示的 ChatGPT 配额窗口')
  return { windows }
}

async function readBounded(response: Response, maxBodyBytes: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) invalid('响应缺少正文')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBodyBytes) invalid(`响应超过 ${maxBodyBytes} 字节上限`)
      chunks.push(value)
    }
  } catch (cause) {
    if (cause instanceof CodexQuotaError) throw cause
    throw new CodexQuotaError('request_error', '读取 ChatGPT 配额响应失败', { cause })
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
  } catch (cause) {
    throw new CodexQuotaError('invalid_wire', 'ChatGPT 配额响应不是有效 JSON', { cause })
  }
}

/** 仅读取 llm-pi-ai 所持有的 OAuth grant；凭据与请求都只留在 Host。 */
export async function readCodexQuota(ctx: Context, options: CodexQuotaOptions = {}): Promise<CodexQuota> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs 必须为正整数')
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new RangeError('maxBodyBytes 必须为正整数')
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = async (): Promise<CodexQuota> => {
    const credentials = ctx.get('credentials')
    if (!credentials) throw new CodexQuotaError('credential_error', '未挂载 credentials 服务')
    let snapshot: ReturnType<typeof oauthPayload>
    try {
      const committed = await credentials.modifyRecord(CODEX_CREDENTIAL_KEY, async (current) => {
        if (current === undefined) {
          throw new CodexQuotaError('not_signed_in', 'Codex 尚未通过 llm-pi-ai 登录 ChatGPT')
        }
        if (current.kind !== 'grant') invalid('Codex 凭据不是 OAuth grant')
        const stored = oauthPayload(current.payload)
        if (stored.expires > Date.now() + REFRESH_MARGIN_MS) return undefined
        const oauth = openaiCodexProvider().auth.oauth
        if (!oauth) throw new CodexQuotaError('refresh_error', 'Codex Provider 未提供 OAuth 刷新能力')
        let refreshed: unknown
        try {
          refreshed = await oauth.refresh(stored, controller.signal)
        } catch (cause) {
          throw new CodexQuotaError('refresh_error', '刷新 Codex OAuth 凭据失败', { cause })
        }
        controller.signal.throwIfAborted()
        oauthPayload(refreshed)
        return { kind: 'grant', payload: refreshed }
      })
      if (committed?.kind !== 'grant') invalid('无法取得已提交的 Codex OAuth grant')
      snapshot = oauthPayload(committed.payload)
    } catch (cause) {
      if (cause instanceof CodexQuotaError) throw cause
      throw new CodexQuotaError('credential_error', '读取或更新 Codex OAuth 凭据失败', { cause })
    }
    controller.signal.throwIfAborted()
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${snapshot.access}`,
          'ChatGPT-Account-ID': snapshot.accountId,
        },
        signal: controller.signal,
        redirect: 'error',
      })
    } catch (cause) {
      throw new CodexQuotaError('request_error', '请求 ChatGPT 配额失败', { cause })
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new CodexQuotaError('http_error', `ChatGPT 配额请求返回 HTTP ${response.status}`)
    }
    return parseUsage(await readBounded(response, maxBodyBytes))
  }
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new CodexQuotaError('timeout', `ChatGPT 配额查询超过 ${timeoutMs} ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
  }
}
