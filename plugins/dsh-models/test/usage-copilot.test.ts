import { describe, expect, it, vi } from 'vitest'
import { getCopilotBilledUsage } from '../src/usage/copilot'

const copilotItem = {
  product: 'Copilot',
  sku: 'Copilot Premium Request',
  model: 'GPT-5',
  unitType: 'requests',
  pricePerUnit: 0.04,
  grossQuantity: 100,
  grossAmount: 4,
  discountQuantity: 25,
  discountAmount: 1,
  netQuantity: 75,
  netAmount: 3,
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const report = {
  timePeriod: { year: 2025, month: 9 },
  user: 'monalisa',
  usageItems: [copilotItem],
}

const options = { token: 'test-token', username: 'monalisa' }

describe('GitHub Copilot billed premium usage', () => {
  it('requests only the documented personal billing endpoint and returns billed amounts, not a quota', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(report))
    const result = await getCopilotBilledUsage({ ...options, fetch: fetchMock })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/users/monalisa/settings/billing/premium_request/usage',
    )
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(request).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(new Headers(request.headers).get('authorization')).toBe('Bearer test-token')
    expect(new Headers(request.headers).get('accept')).toBe('application/vnd.github+json')
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({
      payer: { kind: 'user', name: 'monalisa' },
      timePeriod: report.timePeriod,
      usageItems: [copilotItem],
    })
    expect(result).not.toHaveProperty('remaining')
    expect(result).not.toHaveProperty('percentage')
  })

  it('resolves the authenticated login before requesting personal billing when username is absent', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      url === 'https://api.github.com/user'
        ? json({ login: 'octocat', organizations: ['example-org'] })
        : json(report),
    )
    await expect(getCopilotBilledUsage({ token: options.token, fetch: fetchMock })).resolves.toMatchObject({
      payer: { kind: 'user', name: 'octocat' },
      usageItems: [copilotItem],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/user',
      'https://api.github.com/users/octocat/settings/billing/premium_request/usage',
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
    expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(fetchMock.mock.calls[1]?.[1]?.signal)
  })

  it('uses organization billing only when the paying org is explicit', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json({ ...report, organization: 'example-org', user: undefined }),
    )
    await expect(
      getCopilotBilledUsage({ token: options.token, org: 'example-org', fetch: fetchMock }),
    ).resolves.toMatchObject({
      payer: { kind: 'organization', name: 'example-org' },
      usageItems: [copilotItem],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/organizations/example-org/settings/billing/premium_request/usage',
    )
  })

  it('rejects invalid authenticated logins without contacting a billing or organization endpoint', async () => {
    for (const login of [undefined, null, '', '../evil', 'github.com@evil.test', 'a'.repeat(40), 123]) {
      const fetchMock = vi.fn(async (_url: string | URL | Request) =>
        json({ login, organizations: ['example-org'] }),
      )
      await expect(getCopilotBilledUsage({ token: options.token, fetch: fetchMock })).rejects.toThrow(
        /Invalid GitHub authenticated login.*DSH_COPILOT_BILLING_USERNAME/,
      )
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.github.com/user')
    }
  })

  it('reports identity authorization failures and never guesses an organization payer', async () => {
    for (const status of [401, 403]) {
      const fetchMock = vi.fn(async () =>
        json(
          { message: 'Resource not accessible by personal access token', organizations: ['example-org'] },
          status,
        ),
      )
      await expect(getCopilotBilledUsage({ token: options.token, fetch: fetchMock })).rejects.toThrow(
        new RegExp(
          `identity lookup failed: GitHub identity HTTP ${status}: Resource not accessible.*DSH_COPILOT_BILLING_USERNAME`,
        ),
      )
      expect(fetchMock).toHaveBeenCalledOnce()
    }
  })

  it('rejects invalid identity JSON, oversized or non-JSON responses without billing requests', async () => {
    const responses = [
      new Response('{invalid', { headers: { 'content-type': 'application/json' } }),
      json([]),
      json({ login: 'octocat' }, 200, { 'content-length': '1048577' }),
      new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    ]
    for (const response of responses) {
      const fetchMock = vi.fn(async () => response)
      await expect(getCopilotBilledUsage({ token: options.token, fetch: fetchMock })).rejects.toThrow(
        /GitHub identity lookup failed:.*DSH_COPILOT_BILLING_USERNAME/,
      )
      expect(fetchMock).toHaveBeenCalledOnce()
    }
  })

  it('keeps tokens out of identity errors and never follows redirects', async () => {
    const token = 'private-test-token'
    const redirect = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(init?.redirect).toBe('error')
      throw new Error(`redirect blocked to https://evil.test/?token=${token}`)
    })
    let error: Error | undefined
    try {
      await getCopilotBilledUsage({ token, fetch: redirect })
    } catch (cause) {
      error = cause as Error
    }
    expect(error?.message).toContain('redirect blocked')
    expect(error?.message).toContain('DSH_COPILOT_BILLING_USERNAME')
    expect(error?.message).not.toContain(token)
    expect((error?.cause as Error).message).not.toContain(token)
    expect(redirect).toHaveBeenCalledOnce()
    expect(redirect.mock.calls[0]?.[0]).toBe('https://api.github.com/user')
  })

  it('reports the underlying identity network failure without making a billing request', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error('network offline')
    })
    await expect(getCopilotBilledUsage({ token: options.token, fetch: fetchMock })).rejects.toThrow(
      /GitHub identity lookup failed:.*network offline.*DSH_COPILOT_BILLING_USERNAME/,
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reports identity request timeout instead of trying another payer', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new Error('timeout')))
    try {
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        throw init?.signal?.reason
      })
      await expect(getCopilotBilledUsage({ token: options.token, fetch: fetchMock })).rejects.toThrow(
        /GitHub identity lookup failed:.*timeout.*DSH_COPILOT_BILLING_USERNAME/,
      )
      expect(timeout).toHaveBeenCalledWith(10_000)
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      timeout.mockRestore()
    }
  })

  it('filters other products by default but permits unfiltered billed usage', async () => {
    const other = { ...copilotItem, product: 'Other', sku: 'Another Premium Request' }
    const fetchMock = vi.fn(async () => json({ ...report, usageItems: [copilotItem, other] }))
    expect((await getCopilotBilledUsage({ ...options, fetch: fetchMock })).usageItems).toEqual([copilotItem])
    expect(
      (await getCopilotBilledUsage({ ...options, copilotOnly: false, fetch: fetchMock })).usageItems,
    ).toEqual([copilotItem, other])
  })

  it('does not send tokens to attacker-controlled account names or URLs', async () => {
    const fetchMock = vi.fn(async () => json(report))
    for (const invalid of ['../../evil', 'github.com@evil.test', 'name?x=1', '', ' abc', 'a'.repeat(40)]) {
      await expect(
        getCopilotBilledUsage({ ...options, username: invalid, fetch: fetchMock }),
      ).rejects.toThrow('Invalid GitHub username')
      await expect(getCopilotBilledUsage({ ...options, org: invalid, fetch: fetchMock })).rejects.toThrow(
        'Invalid GitHub payer organization',
      )
    }
    await expect(
      getCopilotBilledUsage({ ...options, token: 'token\nInjected: header', fetch: fetchMock }),
    ).rejects.toThrow('valid GitHub billing token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports authorization failures with status, GitHub reason and personal billing scope', async () => {
    const fetchMock = vi.fn(async () =>
      json({ message: 'Resource not accessible by personal access token' }, 403),
    )
    await expect(getCopilotBilledUsage({ ...options, fetch: fetchMock })).rejects.toThrow(
      /HTTP 403: Resource not accessible by personal access token.*excludes organization-billed Copilot seats/,
    )
    try {
      await getCopilotBilledUsage({ ...options, fetch: fetchMock })
    } catch (error) {
      expect((error as Error & { cause: unknown }).cause).toMatchObject({ status: 403 })
    }
  })

  it('preserves the original network error as cause', async () => {
    const offline = new Error('network offline')
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw offline
    })
    await expect(getCopilotBilledUsage({ ...options, fetch: fetchMock })).rejects.toMatchObject({
      cause: offline,
    })
  })

  it('rejects oversized responses even if Content-Length is absent or dishonest', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 1)
    const fetchMock = vi.fn(
      async () => new Response(huge, { headers: { 'content-type': 'application/json' } }),
    )
    await expect(getCopilotBilledUsage({ ...options, fetch: fetchMock })).rejects.toThrow(
      'failed to read response',
    )
    fetchMock.mockImplementation(async () => json(report, 200, { 'content-length': '1048577' }))
    await expect(getCopilotBilledUsage({ ...options, fetch: fetchMock })).rejects.toThrow(
      'failed to read response',
    )
  })

  it('rejects invalid JSON, missing fields, incorrect types, and non-JSON responses', async () => {
    const badReports = [
      new Response('{invalid', { headers: { 'content-type': 'application/json' } }),
      json({ ...report, timePeriod: {} }),
      json({ ...report, usageItems: [{ ...copilotItem, netQuantity: '75' }] }),
      json({ ...report, usageItems: null }),
    ]
    for (const response of badReports) {
      const fetchMock = vi.fn(async () => response)
      await expect(getCopilotBilledUsage({ ...options, fetch: fetchMock })).rejects.toThrow(
        'GitHub billing response is invalid',
      )
    }
    const fetchMock = vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }))
    await expect(getCopilotBilledUsage({ ...options, fetch: fetchMock })).rejects.toThrow(
      'non-JSON Content-Type',
    )
  })
})
