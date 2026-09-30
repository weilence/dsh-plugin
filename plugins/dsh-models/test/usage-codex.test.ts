import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_CREDENTIAL_KEY, CodexQuotaError, readCodexQuota } from '../src/usage/codex'

const refresh = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({
  openaiCodexProvider: () => ({ auth: { oauth: { refresh } } }),
}))

const grant = {
  kind: 'grant',
  payload: {
    type: 'oauth',
    access: 'access-secret',
    refresh: 'refresh-secret',
    accountId: 'account-secret',
    expires: Date.now() + 3_600_000,
  },
} as const
const primary = {
  used_percent: 100,
  limit_window_seconds: 18_000,
  reset_after_seconds: 900,
  reset_at: 2_000_000_000,
}
const base = {
  plan_type: 'plus',
  rate_limit: { allowed: true, limit_reached: false, primary_window: primary, secondary_window: null },
}

function setup(initial: CredentialRecord | null = grant) {
  let current: CredentialRecord | undefined = initial ?? undefined
  const modifyRecord = vi.fn(
    async (_key, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      current = (await mutate(current)) ?? current
      return current
    },
  )
  const ctx = { get: (key: string) => (key === 'credentials' ? { modifyRecord } : undefined) } as Context
  return { ctx, modifyRecord, current: () => current }
}

function fakeFetch(value: unknown = base, status = 200) {
  return vi.fn<typeof fetch>(async () => Response.json(value, { status }))
}

describe('Codex ChatGPT 配额直接读取', () => {
  beforeEach(() => refresh.mockReset())
  it('用同一锁内快照的 access 与 accountId 请求固定 URL，不根据百分比推断可用性', async () => {
    const { ctx, modifyRecord } = setup()
    const request = fakeFetch()
    await expect(readCodexQuota(ctx, { fetch: request })).resolves.toEqual({
      windows: [
        {
          bucketId: 'codex',
          bucketName: 'Codex',
          kind: 'primary',
          usedPct: 100,
          resetMs: 2_000_000_000_000,
          windowMins: 300,
        },
      ],
    })
    expect(modifyRecord).toHaveBeenCalledOnce()
    expect(modifyRecord.mock.calls[0]?.[0]).toBe(CODEX_CREDENTIAL_KEY)
    expect(request).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers: { Authorization: 'Bearer access-secret', 'ChatGPT-Account-ID': 'account-secret' },
      signal: expect.any(AbortSignal),
      redirect: 'error',
    })
  })

  it('刷新 5 分钟内即将过期的凭据，并使用刷新结果的账户与 access', async () => {
    const { ctx, current } = setup({
      kind: 'grant',
      payload: { ...grant.payload, expires: Date.now() + 60_000 },
    })
    const request = fakeFetch()
    refresh.mockResolvedValueOnce({
      ...grant.payload,
      access: 'new-access',
      accountId: 'new-account',
      expires: Date.now() + 3_600_000,
    })
    await readCodexQuota(ctx, { fetch: request })
    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({ refresh: 'refresh-secret' })
    expect(refresh.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    expect(current()).toMatchObject({
      kind: 'grant',
      payload: { access: 'new-access', accountId: 'new-account' },
    })
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: 'Bearer new-access',
      'ChatGPT-Account-ID': 'new-account',
    })
  })

  it('刷新失败保留原因、不发旧 token 请求、不给浏览器泄露敏感字段', async () => {
    const { ctx } = setup({ kind: 'grant', payload: { ...grant.payload, expires: Date.now() - 1 } })
    const cause = new Error('refresh-secret access-secret account-secret')
    refresh.mockRejectedValueOnce(cause)
    const request = fakeFetch()
    const failure = (await readCodexQuota(ctx, { fetch: request }).catch(
      (error: unknown) => error,
    )) as CodexQuotaError
    expect(failure).toMatchObject({ code: 'refresh_error', cause })
    expect(failure.message).not.toContain('secret')
    expect(request).not.toHaveBeenCalled()
  })

  it('输出顶层与所有附加桶，忽略未消费的 allowed/limit_reached 字段', async () => {
    const { ctx } = setup()
    const request = fakeFetch({
      ...base,
      rate_limit: { ...base.rate_limit, allowed: false, limit_reached: true },
      additional_rate_limits: [
        {
          limit_name: 'Reviews',
          metered_feature: 'code_review',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { ...primary, used_percent: 0 },
            secondary_window: { ...primary, used_percent: 25, limit_window_seconds: 604_800 },
          },
        },
        { limit_name: 'Inactive', metered_feature: 'inactive', rate_limit: null },
      ],
    })
    const quota = await readCodexQuota(ctx, { fetch: request })
    expect(quota.windows).toHaveLength(3)
    expect(quota.windows[0]).toMatchObject({ usedPct: 100 })
    expect(quota.windows[1]).toMatchObject({
      bucketId: 'code_review',
      bucketName: 'Reviews',
      usedPct: 0,
    })
    expect(quota.windows[2]).toMatchObject({ bucketId: 'code_review', kind: 'secondary', windowMins: 10080 })
  })

  it('没有默认桶时仍能展示附加桶', async () => {
    const { ctx } = setup()
    const value = await readCodexQuota(ctx, {
      fetch: fakeFetch({
        plan_type: 'plus',
        rate_limit: null,
        additional_rate_limits: [
          {
            limit_name: 'Other',
            metered_feature: 'other',
            rate_limit: {
              allowed: false,
              limit_reached: true,
              primary_window: primary,
            },
          },
        ],
      }),
    })
    expect(value).toEqual({
      windows: [
        {
          bucketId: 'other',
          bucketName: 'Other',
          kind: 'primary',
          usedPct: 100,
          resetMs: 2_000_000_000_000,
          windowMins: 300,
        },
      ],
    })
  })

  it.each([
    [null, 'not_signed_in'],
    [{ kind: 'api-key', key: 'secret' }, 'invalid_wire'],
    [{ kind: 'grant', payload: { ...grant.payload, accountId: '' } }, 'invalid_wire'],
    [{ kind: 'grant', payload: { ...grant.payload, access: '' } }, 'invalid_wire'],
  ] as const)('拒绝缺失或无效的 OAuth grant', async (record, code) => {
    const { ctx } = setup(record)
    const request = fakeFetch()
    await expect(readCodexQuota(ctx, { fetch: request })).rejects.toMatchObject({ code })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    [
      { ...base, rate_limit: { ...base.rate_limit, primary_window: { ...primary, reset_at: 'bad' } } },
      'reset_at',
    ],
    [
      { ...base, rate_limit: { ...base.rate_limit, primary_window: { ...primary, used_percent: -1 } } },
      'used_percent',
    ],
    [{ ...base, rate_limit: null }, '没有可展示'],
  ])('拒绝无效的官方响应而不猜测数据', async (body, message) => {
    const { ctx } = setup()
    await expect(readCodexQuota(ctx, { fetch: fakeFetch(body) })).rejects.toMatchObject({
      code: 'invalid_wire',
      message: expect.stringContaining(message),
    })
  })

  it('附加桶的任意 ID 不会被带入错误消息', async () => {
    const { ctx } = setup()
    const request = fakeFetch({
      plan_type: 'plus',
      additional_rate_limits: [
        {
          limit_name: 'Unsafe',
          metered_feature: 'refresh-secret',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { ...primary, reset_at: 'bad' },
          },
        },
      ],
    })
    const failure = (await readCodexQuota(ctx, { fetch: request }).catch(
      (error: unknown) => error,
    )) as CodexQuotaError
    expect(failure.code).toBe('invalid_wire')
    expect(failure.message).not.toContain('secret')
  })

  it('HTTP 错误只暴露状态码，不暴露带密钥的响应正文', async () => {
    const { ctx } = setup()
    const request = vi.fn<typeof fetch>(
      async () => new Response('access-secret refresh-secret account-secret', { status: 401 }),
    )
    const error = (await readCodexQuota(ctx, { fetch: request }).catch(
      (cause: unknown) => cause,
    )) as CodexQuotaError
    expect(error).toMatchObject({ code: 'http_error', message: 'ChatGPT 配额请求返回 HTTP 401' })
    expect(error.message).not.toContain('secret')
  })

  it('保留请求与锁失败的真实 cause，展示消息不回显密钥', async () => {
    const cause = new Error('access-secret refresh-secret account-secret')
    const { ctx } = setup()
    const request = vi.fn<typeof fetch>(async () => {
      throw cause
    })
    const failure = (await readCodexQuota(ctx, { fetch: request }).catch(
      (error: unknown) => error,
    )) as CodexQuotaError
    expect(failure.code).toBe('request_error')
    expect(failure.cause).toBe(cause)
    expect(failure.message).not.toContain('secret')
    const broken = {
      get: () => ({
        modifyRecord: async () => {
          throw cause
        },
      }),
    } as unknown as Context
    const storeFailure = (await readCodexQuota(broken, { fetch: request }).catch(
      (error: unknown) => error,
    )) as CodexQuotaError
    expect(storeFailure.code).toBe('credential_error')
    expect(storeFailure.cause).toBe(cause)
    expect(storeFailure.message).not.toContain('secret')
  })

  it('限定整个操作超时、阻断仍未完成的凭据查询继续请求', async () => {
    let finish!: () => void
    const ctx = {
      get: () => ({
        modifyRecord: async () =>
          new Promise<CredentialRecord>((resolve) => {
            finish = () => resolve(grant)
          }),
      }),
    } as unknown as Context
    const request = fakeFetch()
    await expect(readCodexQuota(ctx, { fetch: request, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'timeout',
    })
    finish()
    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()
  })

  it('流式读取超过上限的响应立即拒绝，不把响应正文回显', async () => {
    const { ctx } = setup()
    const request = fakeFetch({ ...base, huge: 'access-secret'.repeat(100) })
    await expect(readCodexQuota(ctx, { fetch: request, maxBodyBytes: 100 })).rejects.toMatchObject({
      code: 'invalid_wire',
      message: expect.stringContaining('100 字节上限'),
    })
  })
})
