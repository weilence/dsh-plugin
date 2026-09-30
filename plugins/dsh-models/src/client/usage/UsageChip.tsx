import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
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
import type { UsageStrings } from './locales'
import { formatReset, providerName, usageStrings, windowName } from './locales'
import { USAGE_PROVIDERS, type ProviderUsage, type UsageWindow } from '../../usage/types'
import pill from './usage-pill.module.css'
import panel from './usage-panel.module.css'

const EMPTY: ModelDirectoryState | null = null

function useActiveLocale(locale: LocaleRuntime): string {
  const subscribe = useCallback((listener: () => void) => locale.subscribe(listener), [locale])
  return useSyncExternalStore(subscribe, () => locale.getLocale().active)
}

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

async function fetchUsage(
  provider: string,
  force: boolean,
  lookupFailed: UsageStrings['lookupFailed'],
): Promise<ProviderUsage> {
  const url = `/dsh-models/usage?provider=${encodeURIComponent(provider)}${force ? '&force=1' : ''}`
  const response = await fetch(url)
  const result = (await response.json()) as ProviderUsage & { error?: unknown }
  if (!response.ok)
    throw new Error(typeof result.error === 'string' ? result.error : lookupFailed(response.status))
  return result
}

function useUsage(provider: string, locale: string) {
  const [result, setResult] = useState<ProviderUsage | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const latestRequest = useRef(0)
  const request = useCallback(
    async (force: boolean) => {
      const sequence = ++latestRequest.current
      if (force) setRefreshing(true)
      try {
        const next = await fetchUsage(provider, force, usageStrings(locale).lookupFailed)
        if (latestRequest.current === sequence) setResult(next)
      } catch (error) {
        if (latestRequest.current === sequence)
          setResult({
            kind: 'unavailable',
            provider,
            error: error instanceof Error ? error.message : String(error),
          })
      } finally {
        if (latestRequest.current === sequence) setRefreshing(false)
      }
    },
    [provider, locale],
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

function formatQueriedAt(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Host 缓存下查询时间可能滞后；Copilot 额度来自未公开接口。 */
export function footerNote(result: ProviderUsage | null, locale: string): string {
  const t = usageStrings(locale)
  if (result?.kind === 'quota')
    return `${result.provider === 'github-copilot' ? t.githubPrivateApi : ''}${t.updatedAt(formatQueriedAt(result.queriedAt))}`
  return t.currentProviderOnly
}

function WindowGrid({ windows, locale }: { windows: readonly UsageWindow[]; locale: string }) {
  const t = usageStrings(locale)
  return (
    <div className={panel.windows}>
      {windows.map((window) => {
        const left = remainingPct(window.usedPct)
        const color = remainingTone(left)
        const name = windowName(window.label, locale)
        const reset = formatReset(window.resetMs, locale)
        const pct = window.unlimited ? t.unlimited : formatPct(left)
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
                {t.remainingQuota(window.remaining, window.entitlement)}
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

export function UsageDetails({ result, locale }: { result: ProviderUsage | null; locale: string }) {
  const t = usageStrings(locale)
  if (result?.kind === 'quota') return <WindowGrid windows={result.windows} locale={locale} />
  return (
    <dl className={panel.details}>
      <dt>{result === null ? t.status : t.reason}</dt>
      <dd>{result === null ? t.loading : result.error}</dd>
    </dl>
  )
}

function UsageSummary({
  label,
  result,
  locale,
}: {
  label: string
  result: ProviderUsage | null
  locale: string
}) {
  const t = usageStrings(locale)
  if (result?.kind === 'unavailable')
    return <span className={toneStyles.err}>{t.usageUnavailable(label)}</span>
  if (result?.kind === 'quota')
    return (
      <>
        {label}
        {result.windows.map((window) => {
          const left = remainingPct(window.usedPct)
          const name = windowName(window.label, locale)
          const pct = window.unlimited ? t.unlimited : formatPct(left)
          return (
            <span key={window.id} className={pill.sep} title={t.remainingOf(name, pct)}>
              {name} <span className={remainingTone(left)}>{pct}</span>
            </span>
          )
        })}
      </>
    )
  return <>{t.usage(label)}…</>
}

function UsagePill({ provider, locale: store }: { provider: string; locale: LocaleRuntime }) {
  const locale = useActiveLocale(store)
  const { result, refreshing, refresh } = useUsage(provider, locale)
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
  const label = providerName(provider, locale)
  const t = usageStrings(locale)
  const content = (
    <>
      <IconGaugeOutlineRegular />
      <span className={pill.label}>
        <UsageSummary label={label} result={result} locale={locale} />
      </span>
    </>
  )
  return (
    <span ref={anchor} className={pill.anchor}>
      {result === null ? (
        <Pill aria-label={t.usageLoading(label)}>{content}</Pill>
      ) : (
        // 展开态不加 active 填充，与模型选择触发器一致：静止无填充，悬停才有 hover 底色。
        <Pill
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t.usage(label)}
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
            aria-label={t.usage(label)}
            style={pos ?? undefined}
          >
            <div className={panel.title}>
              <span className={panel.titleLabel}>
                <IconGaugeOutlineRegular />
                {t.usage(label)}
              </span>
            </div>
            <div className={panel.titleRule} aria-hidden />
            <UsageDetails result={result} locale={locale} />
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
                {refreshing ? t.refreshing : t.refresh}
              </Button>
              <span className={panel.note}>{footerNote(result, locale)}</span>
            </div>
          </MenuSurface>,
          document.body,
        )}
    </span>
  )
}

export function ProviderUsageChip({
  sessionId,
  directories,
  locale,
}: {
  sessionId: SessionId
  directories?: ModelDirectoryResolver
  locale: LocaleRuntime
}) {
  const provider = useProvider(directories, sessionId)
  if (provider === null || !(USAGE_PROVIDERS as readonly string[]).includes(provider)) return null
  return <UsagePill key={provider} provider={provider} locale={locale} />
}
