import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { UsageError } from './types'

export const COPILOT_CREDENTIAL_KEY = credentialKey('llm-pi-ai', 'github-copilot')
const USAGE_URL = 'https://api.github.com/copilot_internal/user'
const MAX_RESPONSE_BYTES = 1024 * 1024

export interface CopilotQuota {
  remainingPct: number | null
  remaining: number | null
  entitlement: number | null
  unlimited: boolean
  resetMs: number | null
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(reason: string): never {
  throw new Error(`Copilot 套餐额度响应无效：${reason}`)
}

function count(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) invalid(`${field} 无效`)
  return parsed
}

function parseQuota(value: unknown): CopilotQuota {
  if (!object(value) || !object(value.quota_snapshots)) invalid('缺少 quota_snapshots')
  const snapshot = value.quota_snapshots.premium_interactions
  if (!object(snapshot)) invalid('缺少 premium_interactions')
  if (snapshot.is_placeholder === true) invalid('premium_interactions 是占位数据')
  if (snapshot.is_placeholder !== undefined && typeof snapshot.is_placeholder !== 'boolean') {
    invalid('premium_interactions.is_placeholder 无效')
  }
  if (typeof snapshot.unlimited !== 'boolean') invalid('premium_interactions.unlimited 无效')
  const unlimited = snapshot.unlimited
  const remaining = unlimited ? null : count(snapshot.remaining, 'premium_interactions.remaining')
  const entitlement = unlimited ? null : count(snapshot.entitlement, 'premium_interactions.entitlement')
  const percent = snapshot.percent_remaining
  if (
    !unlimited &&
    (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100)
  ) {
    invalid('premium_interactions.percent_remaining 无效')
  }
  const date = value.quota_reset_date
  let resetMs: number | null = null
  if (date != null) {
    if (typeof date !== 'string' || !date || !Number.isFinite(Date.parse(date))) {
      invalid('quota_reset_date 无效')
    }
    resetMs = Date.parse(date)
  }
  return {
    remainingPct: unlimited ? null : (percent as number),
    remaining,
    entitlement,
    unlimited,
    resetMs,
  }
}

async function readBounded(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) invalid('响应超过 1 MiB')
  if (!response.body) invalid('缺少响应正文')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) invalid('响应超过 1 MiB')
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
  } catch {
    invalid('正文不是有效 JSON')
  }
}

/** 使用 llm-pi-ai 的 GitHub OAuth token；Copilot 模型请求使用的 access token 不适用于此接口。 */
export async function readCopilotQuota(
  ctx: Context,
  options: { fetch?: typeof fetch } = {},
): Promise<CopilotQuota> {
  const credentials = ctx.get('credentials')
  if (!credentials) throw new Error('未挂载 credentials 服务')
  const grant = await credentials.modifyRecord(COPILOT_CREDENTIAL_KEY, async () => undefined)
  if (!grant) throw new UsageError('not_signed_in', 'Copilot 尚未通过 llm-pi-ai 登录 GitHub')
  if (grant.kind !== 'grant' || !object(grant.payload) || grant.payload.type !== 'oauth') {
    throw new Error('Copilot 凭据不是 OAuth grant')
  }
  if (grant.payload.enterpriseUrl)
    throw new UsageError('unsupported_account', 'Copilot Enterprise 账号暂不支持此 GitHub.com 额度接口')
  const token = grant.payload.refresh
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) {
    throw new Error('Copilot GitHub OAuth 令牌无效')
  }
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(USAGE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `token ${token}`,
        'Editor-Version': 'vscode/1.107.0',
        'Editor-Plugin-Version': 'copilot-chat/0.35.0',
        'User-Agent': 'GitHubCopilotChat/0.35.0',
        'X-GitHub-Api-Version': '2025-04-01',
      },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
  } catch (cause) {
    const detail = (cause instanceof Error ? cause.message : String(cause)).replaceAll(token, '[redacted]')
    throw new Error(`请求 GitHub Copilot 套餐额度失败：${detail}`)
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error(
      `GitHub Copilot 套餐额度请求返回 HTTP ${response.status}（OAuth 授权或私有接口可能已变化）`,
    )
  }
  if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    void response.body?.cancel().catch(() => {})
    throw new Error('GitHub Copilot 套餐额度响应不是 JSON')
  }
  return parseQuota(await readBounded(response))
}
