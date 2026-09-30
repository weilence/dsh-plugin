import { describe, expect, it, vi } from 'vitest'
import { COPILOT_CREDENTIAL_KEY, readCopilotQuota } from '../src/usage/copilot'

const snapshot = {
  quota_reset_date: '2026-10-01T00:00:00Z',
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      remaining: 210,
      percent_remaining: 70,
      unlimited: false,
    },
  },
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function context(payload: unknown = { type: 'oauth', refresh: 'github-oauth', access: 'copilot-api' }) {
  const modifyRecord = vi.fn(
    async (_key: string, callback: (record: unknown) => Promise<unknown> | unknown) => {
      const current = payload === null ? undefined : { kind: 'grant', payload }
      await callback(current)
      return current
    },
  )
  return { ctx: { get: () => ({ modifyRecord }) } as never, modifyRecord }
}

describe('GitHub Copilot 套餐额度私有接口', () => {
  it('复用当前模型登录的 GitHub OAuth token，不使用 Copilot access 或 Billing PAT', async () => {
    const { ctx, modifyRecord } = context()
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(snapshot))
    const result = await readCopilotQuota(ctx, { fetch: request })
    expect(modifyRecord).toHaveBeenCalledWith(COPILOT_CREDENTIAL_KEY, expect.any(Function))
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[0]).toBe('https://api.github.com/copilot_internal/user')
    const init = request.mock.calls[0]?.[1] as RequestInit
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(new Headers(init.headers).get('authorization')).toBe('token github-oauth')
    expect(new Headers(init.headers).get('editor-version')).toBeTruthy()
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({
      remainingPct: 70,
      remaining: 210,
      entitlement: 300,
      unlimited: false,
      resetMs: Date.parse('2026-10-01T00:00:00Z'),
    })
  })

  it('无限量及无重置时间明确表示未知数值，不伪造零额度', async () => {
    const { ctx } = context()
    const request = vi.fn(async () =>
      json({ quota_snapshots: { premium_interactions: { unlimited: true } } }),
    )
    await expect(readCopilotQuota(ctx, { fetch: request })).resolves.toEqual({
      remainingPct: null,
      remaining: null,
      entitlement: null,
      unlimited: true,
      resetMs: null,
    })
  })

  it('未登录、无效凭据或 Enterprise 登录不发送请求', async () => {
    const fetchMock = vi.fn(async () => json(snapshot))
    for (const [payload, reason] of [
      [null, '尚未'],
      [{ type: 'api_key', refresh: 'github-oauth' }, 'OAuth grant'],
      [{ type: 'oauth', refresh: 'invalid\r\nHeader: x' }, '令牌无效'],
      [{ type: 'oauth', refresh: 'github-oauth', enterpriseUrl: 'example.ghe.com' }, 'Enterprise'],
    ] as const) {
      const { ctx } = context(payload)
      await expect(readCopilotQuota(ctx, { fetch: fetchMock })).rejects.toThrow(reason)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('缺失或无效的高级请求快照明确失败，不拿其他配额充数', async () => {
    const { ctx } = context()
    for (const response of [
      json({ quota_snapshots: { chat: { percent_remaining: 80 } } }),
      json({
        ...snapshot,
        quota_snapshots: {
          premium_interactions: { ...snapshot.quota_snapshots.premium_interactions, is_placeholder: true },
        },
      }),
      json({
        ...snapshot,
        quota_snapshots: {
          premium_interactions: { ...snapshot.quota_snapshots.premium_interactions, percent_remaining: 130 },
        },
      }),
      json({
        ...snapshot,
        quota_snapshots: {
          premium_interactions: { ...snapshot.quota_snapshots.premium_interactions, remaining: 'unknown' },
        },
      }),
      json({ ...snapshot, quota_reset_date: 'invalid date' }),
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    ]) {
      await expect(readCopilotQuota(ctx, { fetch: async () => response })).rejects.toThrow()
    }
  })

  it('限制正文大小并拒绝非 JSON、无正文及无效 JSON', async () => {
    const { ctx } = context()
    for (const response of [
      json(snapshot, 200, { 'content-length': '1048577' }),
      new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      new Response(null, { headers: { 'content-type': 'application/json' } }),
    ]) {
      await expect(readCopilotQuota(ctx, { fetch: async () => response })).rejects.toThrow()
    }
  })

  it('报告状态码与网络错误，同时不泄漏 OAuth token', async () => {
    const { ctx } = context()
    await expect(
      readCopilotQuota(ctx, { fetch: async () => json({ message: 'private' }, 403) }),
    ).rejects.toThrow(/HTTP 403.*私有接口可能已变化/)
    await expect(
      readCopilotQuota(ctx, {
        fetch: async () => {
          throw new Error('网络断开 github-oauth')
        },
      }),
    ).rejects.toThrow('网络断开 [redacted]')
  })
})
