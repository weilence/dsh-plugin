import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'
import type { UsageProviderId, UsageWindowLabel } from '../../usage/types'

dayjs.extend(relativeTime)

/** DSH 内置语言只有 zh/en；dayjs 的中文数据 id 是 zh-cn，其余语言无内置数据，统一回退英文。 */
export function dayjsLocaleId(active: string): string {
  return active.toLowerCase() === 'zh' ? 'zh-cn' : 'en'
}

const isZh = (locale: string) => dayjsLocaleId(locale) === 'zh-cn'

/** Provider 展示名（host 只下发 id，标识符原样回退）。 */
const PROVIDER_NAMES: Record<UsageProviderId, { zh: string; en: string }> = {
  'zai-coding-cn': { zh: '智谱', en: 'Zhipu' },
  'openai-codex': { zh: 'Codex', en: 'Codex' },
  'github-copilot': { zh: 'Copilot', en: 'Copilot' },
}

export function providerName(provider: string, locale: string): string {
  const names = PROVIDER_NAMES[provider as UsageProviderId]
  if (names === undefined) return provider
  return isZh(locale) ? names.zh : names.en
}

/** 窗口标签文案：已知时长有专名，其余按分钟显示；时长缺失回退主/次窗口角色名。 */
export function windowName(label: UsageWindowLabel, locale: string): string {
  if (label.kind === 'toolCalls') return isZh(locale) ? '工具调用' : 'Tool calls'
  if (label.kind === 'premiumRequests') return isZh(locale) ? '高级请求' : 'Premium requests'
  if (label.kind === 'text') return label.text
  const prefix = label.bucketName === undefined ? '' : `${label.bucketName} · `
  if (label.windowMins === 300) return prefix + (isZh(locale) ? '5 小时' : '5 hours')
  if (label.windowMins === 10080) return prefix + (isZh(locale) ? '每周' : 'Weekly')
  if (label.windowMins !== null) {
    return prefix + (isZh(locale) ? `${label.windowMins} 分钟` : `${label.windowMins} min`)
  }
  if (label.role === 'secondary') return prefix + (isZh(locale) ? '次窗口' : 'Secondary window')
  return prefix + (isZh(locale) ? '主窗口' : 'Primary window')
}

// 英文重置文案用紧凑时长而不是 dayjs 长句（in 5 hours）：浮窗窗口列宽有限，长句会截断。
function compactDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  if (ms < 7 * 86_400_000) return `${Math.round(ms / 86_400_000)}d`
  if (ms < 30 * 86_400_000) return `${Math.round(ms / (7 * 86_400_000))}w`
  return `${Math.round(ms / (30 * 86_400_000))}mo`
}

/** 重置时间：中文沿用 dayjs 相对时间，其余语言用紧凑时长。 */
export function formatReset(resetMs: number | null, locale: string, now = Date.now()): string {
  if (resetMs === null || resetMs <= now) return '—'
  if (isZh(locale)) return `${dayjs(now).locale('zh-cn').to(dayjs(resetMs).locale('zh-cn'))}重置`
  return `resets in ${compactDuration(resetMs - now)}`
}

const ZH = {
  usage: (name: string) => `${name}用量`,
  usageLoading: (name: string) => `${name}用量加载中`,
  lookupFailed: (status: number) => `用量查询失败（HTTP ${status}）`,
  refresh: '刷新',
  refreshing: '刷新中…',
  updatedAt: (time: string) => `更新于 ${time}`,
  githubPrivateApi: 'GitHub 私有接口 · ',
  currentProviderOnly: '仅当前 Provider 显示',
  status: '状态',
  reason: '原因',
  loading: '加载中…',
  usageUnavailable: (name: string) => `${name}用量不可用`,
  unlimited: '不限量',
  remainingQuota: (remaining: number, entitlement: number) => `剩余 ${remaining} / ${entitlement}`,
  remainingOf: (name: string, pct: string) => `${name}剩余 ${pct}`,
}

// 取词函数的返回放宽为 string，EN 词典才不必逐字对齐 ZH 的字面量类型。
export type UsageStrings = {
  [K in keyof typeof ZH]: (typeof ZH)[K] extends (...args: infer A) => unknown
    ? (...args: A) => string
    : (typeof ZH)[K]
}

const EN: UsageStrings = {
  usage: (name) => `${name} usage`,
  usageLoading: (name) => `${name} usage loading`,
  lookupFailed: (status) => `Usage lookup failed (HTTP ${status})`,
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  updatedAt: (time) => `Updated ${time}`,
  githubPrivateApi: 'GitHub private API · ',
  currentProviderOnly: 'Only shown for the current provider',
  status: 'Status',
  reason: 'Reason',
  loading: 'Loading…',
  usageUnavailable: (name) => `${name} usage unavailable`,
  unlimited: 'Unlimited',
  remainingQuota: (remaining, entitlement) => `${remaining} / ${entitlement} left`,
  remainingOf: (name, pct) => `${name}: ${pct} left`,
}

/** 面板固定文案按宿主语言取词。 */
export function usageStrings(locale: string): UsageStrings {
  return isZh(locale) ? ZH : EN
}
