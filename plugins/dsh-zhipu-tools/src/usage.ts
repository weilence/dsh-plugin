// usage.ts — 套餐配额查询（host half）。
// GET QUOTA_URL（Authorization 裸 key）→ parseQuota → 缓存（成功 4 分钟、
// 失败 30 秒）+ inflight 去重。出站走 Node 全局 fetch，自动遵循
// dsh-http-proxy 代理策略；key 绝不下发到 client half。
//
// 线格式（实测）：data.limits[] 条目形如
//   { type: 'TOKENS_LIMIT', unit: 3, percentage }   → 5 小时窗口
//   { type: 'TOKENS_LIMIT', unit: 6, percentage }   → 每周窗口
//   { type: 'TIME_LIMIT',   unit: 5, percentage,
//     usageDetails: [{ modelCode, usage }] }        → 工具调用（按次）
// percentage 是已用百分比；客户端负责换算为剩余（官方面板展示剩余）。
// 未知 type 原样保留（label 回退为 type），顺序即接口顺序。

export interface QuotaWindow {
	id: string
	label: string
	/** API percentage（已用百分比，0-100）；展示时换算为剩余。 */
	usedPct: number | null
	resetMs: number | null
}

export type QuotaStatus =
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

function errMsg(error: unknown) {
	const message = (error as { message?: string } | null | undefined)?.message
	return message || String(error)
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

export function createUsageService(apiKey: string | null) {
	let at = 0
	let status: QuotaStatus | null = null
	let inflight: Promise<QuotaStatus> | null = null

	// force 绕过缓存读取（仍回写）；失败结果也缓存，防止打爆上游。
	async function fetchUsage(force: boolean): Promise<QuotaStatus> {
		const now = Date.now()
		if (!force && status) {
			const ttl = status.ok ? OK_TTL_MS : ERR_TTL_MS
			if (now - at < ttl) return status
		}
		if (inflight) return inflight
		inflight = (async () => {
			let next: QuotaStatus
			if (!apiKey) {
				next = { ok: false, error: '未配置 zai-coding-cn 供应商' }
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
