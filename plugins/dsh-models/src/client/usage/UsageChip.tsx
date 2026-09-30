import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ModelDirectory,
  ModelDirectoryResolver,
  ModelDirectoryState,
} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  Button,
  IconGaugeOutlineRegular,
  IconRefreshOutlineRegular,
  MenuSurface,
  Pill,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { toneStyles } from '@dsh-plugins/client-ui/tone'
import { formatReset, intlLocale, providerName, windowName } from './locales'
import type { ModelsT, NS } from '../locales'
import {
  USAGE_PROVIDERS,
  type ProviderUsage,
  type UsageFailureCode,
  type UsageWindow,
} from '../../usage/types'
import pill from './usage-pill.module.css'
import panel from './usage-panel.module.css'

const EMPTY: ModelDirectoryState | null = null

function useProvider(directories: ModelDirectoryResolver | undefined, sessionId: SessionId) {
  const directory: ModelDirectory | undefined = directories?.directoryFor(sessionId)
  useEffect(() => {
    void directory?.load().catch(() => {})
  }, [directory])
  const subscribe = useCallback(
    (listener: () => void) => directory?.store.subscribe(listener) ?? (() => {}),
    [directory],
  )
  const snapshot = useSyncExternalStore(subscribe, () => directory?.store.getSnapshot() ?? EMPTY)
  return snapshot?.current?.provider ?? null
}

// 用量事实与展示语言无关：失败摘要按 code 在渲染期翻译，请求与轮询只随
// provider 变化，切换语言不重新查询。
async function fetchUsage(provider: string, force: boolean): Promise<ProviderUsage> {
  const url = `/dsh-models/usage?provider=${encodeURIComponent(provider)}${force ? '&force=1' : ''}`
  const response = await fetch(url)
  const result = (await response.json()) as ProviderUsage & { error?: unknown }
  if (!response.ok) {
    const detail =
      typeof result.error === 'string' && result.error.length > 0 ? result.error : `HTTP ${response.status}`
    throw new Error(detail)
  }
  return result
}

function useUsage(provider: string) {
  const [result, setResult] = useState<ProviderUsage | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const latestRequest = useRef(0)
  const request = useCallback(
    async (force: boolean) => {
      const sequence = ++latestRequest.current
      if (force) setRefreshing(true)
      try {
        const next = await fetchUsage(provider, force)
        if (latestRequest.current === sequence) setResult(next)
      } catch (error) {
        if (latestRequest.current === sequence)
          setResult({
            kind: 'unavailable',
            provider,
            code: 'unknown',
            detail: error instanceof Error ? error.message : String(error),
          })
      } finally {
        if (latestRequest.current === sequence) setRefreshing(false)
      }
    },
    [provider],
  )
  useEffect(() => {
    void request(false)
    const timer = setInterval(() => {
      void request(false)
    }, 15_000)
    return () => {
      latestRequest.current += 1
      clearInterval(timer)
    }
  }, [request])
  return { result, refreshing, refresh: () => void request(true) }
}

function remainingPct(usedPct: number | null) {
  return usedPct === null ? null : Math.max(0, Math.min(100, 100 - usedPct))
}

function remainingTone(value: number | null) {
  if (value === null) return undefined
  return value <= 10 ? toneStyles.err : value <= 30 ? toneStyles.warn : toneStyles.ok
}

function formatPct(value: number | null) {
  return value === null ? '—' : Math.round(value * 10) / 10 + '%'
}

function formatQueriedAt(ms: number, active: string) {
  return new Date(ms).toLocaleTimeString(intlLocale(active), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 已知原因码 → 翻译摘要并保留原始详情；unknown 的详情就是主文案，不猜不吞。 */
function failureText(code: UsageFailureCode, detail: string, t: ModelsT) {
  if (code === 'unknown') return detail
  // 四个已知码与词典键一一对应（usage.failure.<code>）；unknown 已提前返回。
  const summary = FAILURE_KEY[code]
  return detail.length === 0 ? t(summary) : `${t(summary)} · ${detail}`
}

const FAILURE_KEY = {
  not_configured: 'usage.failure.not_configured',
  not_signed_in: 'usage.failure.not_signed_in',
  unsupported_account: 'usage.failure.unsupported_account',
  authorization_changed: 'usage.failure.authorization_changed',
} as const

/** Host 缓存下查询时间可能滞后；Copilot 额度来自未公开接口。 */
export function footerNote(result: ProviderUsage | null, t: ModelsT, active: string): string {
  if (result?.kind === 'quota')
    return `${result.provider === 'github-copilot' ? t('usage.githubPrivateApi') : ''}${t('usage.updatedAt', { time: formatQueriedAt(result.queriedAt, active) })}`
  return t('usage.currentProviderOnly')
}

function WindowGrid({ windows, t, active }: { windows: readonly UsageWindow[]; t: ModelsT; active: string }) {
  return (
    <div className={panel.windows}>
      {windows.map((window) => {
        const left = remainingPct(window.usedPct)
        const color = remainingTone(left)
        const name = windowName(window.label, t)
        const reset = formatReset(window.resetMs, active)
        const pct = window.unlimited ? t('usage.unlimited') : formatPct(left)
        return (
          <div key={window.id} className={panel.window}>
            <div className={panel.windowName} title={name}>
              {name}
            </div>
            <div className={panel.windowValue} title={reset}>
              <span className={color}>{pct}</span> · {reset}
            </div>
            {window.remaining != null && window.entitlement != null ? (
              <div className={panel.windowValue}>
                {t('usage.remainingQuota', { remaining: window.remaining, entitlement: window.entitlement })}
              </div>
            ) : null}
            <div className={panel.bar}>
              <div
                className={[panel.fill, color].filter(Boolean).join(' ')}
                style={{ width: (window.unlimited ? 100 : (left ?? 0)) + '%' }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function UsageDetails({
  result,
  t,
  active,
}: {
  result: ProviderUsage | null
  t: ModelsT
  active: string
}) {
  if (result?.kind === 'quota') return <WindowGrid windows={result.windows} t={t} active={active} />
  return (
    <dl className={panel.details}>
      <dt>{result === null ? t('usage.status') : t('usage.reason')}</dt>
      <dd>{result === null ? t('usage.loading') : failureText(result.code, result.detail, t)}</dd>
    </dl>
  )
}

function UsageSummary({
  label,
  result,
  t,
  active,
}: {
  label: string
  result: ProviderUsage | null
  t: ModelsT
  active: string
}) {
  if (result?.kind === 'unavailable')
    return <span className={toneStyles.err}>{t('usage.unavailable', { name: label })}</span>
  if (result?.kind === 'quota')
    return (
      <>
        {label}
        {result.windows.map((window) => {
          const left = remainingPct(window.usedPct)
          const name = windowName(window.label, t)
          const pct = window.unlimited ? t('usage.unlimited') : formatPct(left)
          return (
            <span key={window.id} className={pill.sep} title={t('usage.remainingOf', { name, pct })}>
              {name} <span className={remainingTone(left)}>{pct}</span>
            </span>
          )
        })}
      </>
    )
  return <>{t('usage.title', { name: label })}…</>
}

function UsagePill({ provider, locale, t }: { provider: string; locale: LocaleRuntime; t: ModelsT }) {
  // 展示语言在渲染期读取：slot outlet 订阅 locale revision，语言切换即重绘。
  const active = locale.getLocale().active
  const { result, refreshing, refresh } = useUsage(provider)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const pos = useAnchoredPosition({
    open,
    anchorRef: anchor,
    panelRef: surface,
    side: 'top',
    align: 'end',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(anchor, open, setOpen, surface)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  const label = providerName(provider, active)
  const content = (
    <>
      <IconGaugeOutlineRegular />
      <span className={pill.label}>
        <UsageSummary label={label} result={result} t={t} active={active} />
      </span>
    </>
  )
  return (
    <span ref={anchor} className={pill.anchor}>
      {result === null ? (
        <Pill aria-label={t('usage.titleLoading', { name: label })}>{content}</Pill>
      ) : (
        // 展开态不加 active 填充，与模型选择触发器一致：静止无填充，悬停才有 hover 底色。
        <Pill
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('usage.title', { name: label })}
          onClick={() => setOpen(!open)}
        >
          {content}
        </Pill>
      )}
      {open &&
        createPortal(
          <MenuSurface
            ref={surface}
            className={[panel.panel, pos === null && panel.measure].filter(Boolean).join(' ')}
            role="dialog"
            aria-label={t('usage.title', { name: label })}
            style={pos ?? undefined}
          >
            <div className={panel.title}>
              <span className={panel.titleLabel}>
                <IconGaugeOutlineRegular />
                {t('usage.title', { name: label })}
              </span>
            </div>
            <div className={panel.titleRule} aria-hidden />
            <UsageDetails result={result} t={t} active={active} />
            <div className={panel.footerRule} aria-hidden />
            <div className={panel.footer}>
              <Button
                variant="ghost"
                size="sm"
                icon={<IconRefreshOutlineRegular size={14} />}
                className={panel.refreshButton}
                disabled={refreshing || result === null}
                onClick={refresh}
              >
                {refreshing ? t('usage.refreshing') : t('usage.refresh')}
              </Button>
              <span className={panel.note}>{footerNote(result, t, active)}</span>
            </div>
          </MenuSurface>,
          document.body,
        )}
    </span>
  )
}

/** 注册方注入面（client/index.ts 装配，slot inject 回调提供；sessionId 是 session 域的位置参数）。 */
interface UsageChipInjected {
  sessionId: SessionId
  directories?: ModelDirectoryResolver
  locale: LocaleRuntime
}

/** 完整组件 props：运行时份额 + locale 标准 seat + 注入面。 */
export type ProviderUsageChipProps = PropsRuntime<'conversation.input.right'> &
  PropsLocale<typeof NS> &
  InjectFace<UsageChipInjected>

export function ProviderUsageChip({ sessionId, directories, locale, t }: ProviderUsageChipProps) {
  const provider = useProvider(directories, sessionId)
  if (provider === null || !(USAGE_PROVIDERS as readonly string[]).includes(provider)) return null
  return <UsagePill key={provider} provider={provider} locale={locale} t={t} />
}
