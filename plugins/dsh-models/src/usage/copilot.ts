const GITHUB_API_ORIGIN = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 1024 * 1024

export interface CopilotBillingPeriod {
  year: number
  month?: number
  day?: number
}

export interface CopilotBilledUsageItem {
  product: string
  sku: string
  model?: string
  unitType: string
  pricePerUnit: number
  grossQuantity: number
  grossAmount: number
  discountQuantity: number
  discountAmount: number
  netQuantity: number
  netAmount: number
}

export interface CopilotBilledUsage {
  payer: { kind: 'user' | 'organization'; name: string }
  timePeriod: CopilotBillingPeriod
  usageItems: CopilotBilledUsageItem[]
}

export interface CopilotBillingOptions {
  token: string
  /** 个人计费账户可显式指定；未指定时通过当前令牌查询登录名。 */
  username?: string
  /** 只有明确知道付款组织时才使用组织计费接口。 */
  org?: string
  /** 默认只返回 Copilot；设为 false 时保留高级请求接口返回的全部产品。 */
  copilotOnly?: boolean
  fetch?: typeof globalThis.fetch
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub billing response contains an invalid object')
  }
  return value as Record<string, unknown>
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`GitHub billing response has invalid ${field}`)
  return value
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`GitHub billing response has invalid ${field}`)
  }
  return value
}

function integerField(value: unknown, field: string, min: number, max: number): number {
  const number = numberField(value, field)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`GitHub billing response has invalid ${field}`)
  }
  return number
}

function parseUsage(
  body: unknown,
  payer: CopilotBilledUsage['payer'],
  copilotOnly: boolean,
): CopilotBilledUsage {
  const data = record(body)
  const period = record(data.timePeriod)
  const timePeriod: CopilotBillingPeriod = { year: integerField(period.year, 'timePeriod.year', 1, 9999) }
  if (period.month !== undefined) timePeriod.month = integerField(period.month, 'timePeriod.month', 1, 12)
  if (period.day !== undefined) timePeriod.day = integerField(period.day, 'timePeriod.day', 1, 31)
  if (!Array.isArray(data.usageItems)) throw new Error('GitHub billing response has invalid usageItems')

  const usageItems = data.usageItems.map((value, index): CopilotBilledUsageItem => {
    const item = record(value)
    const field = (name: string) => `usageItems[${index}].${name}`
    const parsed: CopilotBilledUsageItem = {
      product: stringField(item.product, field('product')),
      sku: stringField(item.sku, field('sku')),
      unitType: stringField(item.unitType, field('unitType')),
      pricePerUnit: numberField(item.pricePerUnit, field('pricePerUnit')),
      grossQuantity: numberField(item.grossQuantity, field('grossQuantity')),
      grossAmount: numberField(item.grossAmount, field('grossAmount')),
      discountQuantity: numberField(item.discountQuantity, field('discountQuantity')),
      discountAmount: numberField(item.discountAmount, field('discountAmount')),
      netQuantity: numberField(item.netQuantity, field('netQuantity')),
      netAmount: numberField(item.netAmount, field('netAmount')),
    }
    if (item.model !== undefined && item.model !== null)
      parsed.model = stringField(item.model, field('model'))
    return parsed
  })

  return {
    payer,
    timePeriod,
    usageItems: copilotOnly
      ? usageItems.filter(
          (item) =>
            item.product.toLowerCase() === 'copilot' || item.sku.toLowerCase() === 'copilot premium request',
        )
      : usageItems,
  }
}

async function readBounded(response: Response): Promise<string> {
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    throw new Error(`GitHub billing response exceeds ${MAX_RESPONSE_BYTES} bytes`)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES)
        throw new Error(`GitHub billing response exceeds ${MAX_RESPONSE_BYTES} bytes`)
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function account(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value)) {
    throw new Error(`Invalid GitHub ${field}`)
  }
  return value
}

async function requestGitHub(
  path: string,
  options: CopilotBillingOptions,
  purpose: 'billing' | 'identity',
): Promise<{ response: Response; body: string }> {
  // 请求地址只由固定 GitHub 域名及已验证的账户名构成，禁止令牌跟随重定向。
  const url = new URL(path, GITHUB_API_ORIGIN)
  if (url.origin !== GITHUB_API_ORIGIN) throw new Error('GitHub API URL is not allowed')
  let response: Response
  try {
    response = await (options.fetch ?? globalThis.fetch)(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    })
  } catch (cause) {
    throw new Error(`GitHub ${purpose} request failed or timed out`, { cause })
  }
  try {
    return { response, body: await readBounded(response) }
  } catch (cause) {
    throw new Error(`GitHub ${purpose} HTTP ${response.status}: failed to read response`, { cause })
  }
}

function errorReason(response: Response, body: string): string {
  let reason = response.statusText
  try {
    const message = record(JSON.parse(body)).message
    if (typeof message === 'string' && message.trim()) reason = message
  } catch {
    // 非 JSON 错误页面仍可由 HTTP 状态码定位。
  }
  return reason
}

function assertJson(response: Response, purpose: 'billing' | 'identity'): void {
  if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error(
      `GitHub ${purpose} returned non-JSON Content-Type: ${response.headers.get('content-type')}`,
    )
  }
}

async function authenticatedLogin(options: CopilotBillingOptions): Promise<string> {
  try {
    const { response, body } = await requestGitHub('/user', options, 'identity')
    if (!response.ok) {
      const reason = errorReason(response, body)
      throw new Error(`GitHub identity HTTP ${response.status}${reason ? `: ${reason}` : ''}`)
    }
    assertJson(response, 'identity')
    let identity: unknown
    try {
      identity = JSON.parse(body) as unknown
    } catch {
      throw new Error('GitHub identity response has invalid JSON')
    }
    const login =
      identity && typeof identity === 'object' && !Array.isArray(identity)
        ? (identity as Record<string, unknown>).login
        : undefined
    return account(login, 'authenticated login')
  } catch (cause) {
    // 身份查询失败时不能推测付款组织，也不能把响应中的令牌原样带到错误文本。
    const reason =
      cause instanceof Error
        ? `${cause.message}${cause.cause instanceof Error ? `: ${cause.cause.message}` : ''}`
        : String(cause)
    const safeReason = reason.replaceAll(options.token, '[redacted]')
    throw new Error(
      `GitHub identity lookup failed: ${safeReason}. Configure DSH_COPILOT_BILLING_USERNAME explicitly to use personal billing.`,
      { cause: new Error(safeReason) },
    )
  }
}

/** 个人计费不含组织付费的 Copilot 请求；组织付款方必须显式指定。 */
export async function getCopilotBilledUsage(options: CopilotBillingOptions): Promise<CopilotBilledUsage> {
  if (typeof options.token !== 'string' || !options.token.trim() || /[\r\n]/.test(options.token)) {
    throw new Error('A valid GitHub billing token is required')
  }
  const org = options.org === undefined ? undefined : account(options.org, 'payer organization')
  const payer: CopilotBilledUsage['payer'] = org
    ? { kind: 'organization', name: org }
    : {
        kind: 'user',
        name:
          options.username === undefined
            ? await authenticatedLogin(options)
            : account(options.username, 'username'),
      }
  const path =
    payer.kind === 'organization'
      ? `/organizations/${encodeURIComponent(payer.name)}/settings/billing/premium_request/usage`
      : `/users/${encodeURIComponent(payer.name)}/settings/billing/premium_request/usage`
  const { response, body } = await requestGitHub(path, options, 'billing')
  if (!response.ok) {
    const reason = errorReason(response, body)
    throw new Error(
      `GitHub billing HTTP ${response.status}${reason ? `: ${reason}` : ''}. Personal billing excludes organization-billed Copilot seats; org billing needs an explicit payer org and appropriate permissions.`,
      { cause: { status: response.status, body } },
    )
  }
  assertJson(response, 'billing')
  try {
    return parseUsage(JSON.parse(body) as unknown, payer, options.copilotOnly !== false)
  } catch (cause) {
    throw new Error('GitHub billing response is invalid', { cause })
  }
}
