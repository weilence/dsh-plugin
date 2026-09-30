import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'
import type { UsageWindowLabel } from '../../usage/types'
import type { ModelsT } from '../locales'

dayjs.extend(relativeTime)

/** DSH 内置语言只有 zh/en；dayjs 的中文数据 id 是 zh-cn，其余语言无内置数据，统一回退英文。 */
export function dayjsLocaleId(active: string): string {
  return active.toLowerCase() === 'zh' ? 'zh-cn' : 'en'
}

/** Intl 使用的 BCP 47 标签：跟随宿主语言而不是浏览器默认，脚注时间与界面语言一致。 */
export function intlLocale(active: string): string {
  return dayjsLocaleId(active) === 'zh-cn' ? 'zh-CN' : 'en'
}

/** Provider 展示名（host 只下发 id，标识符原样回退）。 */
const PROVIDER_NAMES: Record<string, { zh: string; en: string }> = {
  'zai-coding-cn': { zh: '智谱', en: 'Zhipu' },
  'openai-codex': { zh: 'Codex', en: 'Codex' },
  'github-copilot': { zh: 'Copilot', en: 'Copilot' },
}

export function providerName(provider: string, locale: string): string {
  const names = PROVIDER_NAMES[provider]
  if (names === undefined) return provider
  return dayjsLocaleId(locale) === 'zh-cn' ? names.zh : names.en
}

/** 窗口标签文案：已知时长有专名，其余按分钟显示；时长缺失回退主/次窗口角色名。 */
export function windowName(label: UsageWindowLabel, t: ModelsT): string {
  if (label.kind === 'toolCalls') return t('usage.window.toolCalls')
  if (label.kind === 'premiumRequests') return t('usage.window.premiumRequests')
  if (label.kind === 'text') return label.text
  const prefix = label.bucketName === undefined ? '' : `${label.bucketName} · `
  if (label.windowMins === 300) return prefix + t('usage.window.hours5')
  if (label.windowMins === 10080) return prefix + t('usage.window.weekly')
  if (label.windowMins !== null) return prefix + t('usage.window.minutes', { mins: label.windowMins })
  if (label.role === 'secondary') return prefix + t('usage.window.secondary')
  return prefix + t('usage.window.primary')
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
  if (dayjsLocaleId(locale) === 'zh-cn')
    return `${dayjs(now).locale('zh-cn').to(dayjs(resetMs).locale('zh-cn'))}重置`
  return `resets in ${compactDuration(resetMs - now)}`
}
