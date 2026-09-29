import { errMsg } from '@dsh-plugins/shared'

export interface QuotaWindow {
  id: string
  label: string
  /** API percentage（已用百分比，0-100）；展示时换算为剩余。 */
  usedPct: number | null
  resetMs: number | null
}

export type UsageResult =
  { ok: true; windows: QuotaWindow[]; queriedAt: number } | { ok: false; error: string }

const QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
const OK_TTL_MS = 4 * 60 * 1000
const ERR_TTL_MS = 30 * 1000
const MAX_BODY_CHARS = 4_000_000

interface QuotaWireItem {
  type?: unknown
  unit?: unknown
  percentage?: unknown
  nextResetTime?: unknown
  /** 工具调用（TIME_LIMIT）窗口附带，本插件不消费。 */
  usageDetails?: unknown
}

// 导出仅为单测；运行时仅经 createUsageService 间接触发。
export interface QuotaWireBody {
  success?: boolean
  msg?: string
  data?: { limits?: QuotaWireItem[] }
}

function toNum(v: unknown) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return n === n ? n : null
}

function clampPct(v: number | null) {
  if (v === null) return null
  return Math.min(100, Math.max(0, v))
}

function labelFor(type: string, unit: number | null) {
  if (type === 'TOKENS_LIMIT' && unit === 3) return '5 小时'
  if (type === 'TOKENS_LIMIT' && unit === 6) return '每周'
  if (type === 'TIME_LIMIT') return '工具调用'
  return type
}

// fetch 对 4xx/5xx 不抛错；体积超限拒绝解析。
async function readBody(res: Response) {
  const text = await res.text()
  if (text.length > MAX_BODY_CHARS) throw new Error('响应超过体积上限，已拒绝解析')
  return text
}

// 导出仅为单测（纯函数，无 IO）。
// 线格式（实测）：data.limits[] 条目形如
//   { type: 'TOKENS_LIMIT', unit: 3, percentage }   → 5 小时窗口
//   { type: 'TOKENS_LIMIT', unit: 6, percentage }   → 每周窗口
//   { type: 'TIME_LIMIT',   unit: 5, percentage,
//     usageDetails: [{ modelCode, usage }] }        → 工具调用（按次）
// percentage 是已用百分比；未知 type 原样保留（label 回退为 type），顺序即
// 接口顺序。
export function parseQuota(body: QuotaWireBody): QuotaWindow[] {
  if (body && body.success === false) {
    throw new Error(String(body?.msg || '接口返回错误'))
  }
  const data = body && body.data
  if (!data || typeof data !== 'object') throw new Error('响应缺少 data 字段')
  const limits = Array.isArray(data.limits) ? data.limits : []
  const windows: QuotaWindow[] = []
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue
    const type = typeof item.type === 'string' ? item.type : ''
    if (!type) continue
    windows.push({
      id: type + '#' + (toNum(item.unit) ?? '?'),
      label: labelFor(type, toNum(item.unit)),
      usedPct: clampPct(toNum(item.percentage)),
      resetMs: toNum(item.nextResetTime),
    })
  }
  if (windows.length === 0) throw new Error('响应缺少配额条目')
  return windows
}

// Authorization 裸 key；key 只留在 host half，绝不下发给 client。
// unavailableReason 是 key 缺席的原因（默认未配置；凭证解析失败时由调用方传入真实原因）。
export function createUsageService(apiKey: string | null, unavailableReason = '未配置 zai-coding-cn 供应商') {
  let at = 0
  let status: UsageResult | null = null
  let inflight: Promise<UsageResult> | null = null

  // force 绕过缓存读取（仍回写）；失败结果也缓存，防止打爆上游。
  async function fetchUsage(force: boolean): Promise<UsageResult> {
    const now = Date.now()
    if (!force && status) {
      const ttl = status.ok ? OK_TTL_MS : ERR_TTL_MS
      if (now - at < ttl) return status
    }
    if (inflight) return inflight
    inflight = (async () => {
      let next: UsageResult
      if (!apiKey) {
        next = { ok: false, error: unavailableReason }
      } else {
        try {
          const res = await fetch(QUOTA_URL, {
            method: 'GET',
            headers: {
              Authorization: apiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(20 * 1000),
          })
          next = { ok: true, windows: parseQuota(JSON.parse(await readBody(res))), queriedAt: now }
        } catch (error) {
          next = { ok: false, error: errMsg(error) }
        }
      }
      at = Date.now()
      status = next
      return next
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  return { fetchUsage }
}
