import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {
  ModelDirectory,
  ModelDirectoryResolver,
  ModelDirectoryState,
} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'
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
import { USAGE_PROVIDERS, type ProviderUsage, type UsageWindow } from '../../usage/types'
import pill from './usage-pill.module.css'
import panel from './usage-panel.module.css'

const EMPTY: ModelDirectoryState | null = null

dayjs.extend(relativeTime)

/** DSH 内置语言只有 zh/en；dayjs 的中文数据 id 是 zh-cn，其余语言无内置数据，统一回退英文。 */
function dayjsLocaleId(active: string): string {
  return active.toLowerCase() === 'zh' ? 'zh-cn' : 'en'
}

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

async function fetchUsage(provider: string, force: boolean): Promise<ProviderUsage> {
  const url = `/dsh-models/usage?provider=${encodeURIComponent(provider)}${force ? '&force=1' : ''}`
  const response = await fetch(url)
  const result = (await response.json()) as ProviderUsage & { error?: unknown }
  if (!response.ok)
    throw new Error(
      `${typeof result.error === 'string' ? result.error : '用量查询失败'}（HTTP ${response.status}）`,
    )
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
            label: USAGE_PROVIDERS[provider as keyof typeof USAGE_PROVIDERS] ?? provider,
            error: error instanceof Error ? error.message : String(error),
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

/** 重置时间用 dayjs 相对时间回答「还要等多久」，语言跟随宿主 locale 服务；缺失或已过期显示 —。 */
export function formatReset(resetMs: number | null, locale: string, now = Date.now()): string {
  if (resetMs === null) return '—'
  const id = dayjsLocaleId(locale)
  const reset = dayjs(resetMs).locale(id)
  if (reset.isBefore(dayjs(now))) return '—'
  const relative = dayjs(now).locale(id).to(reset)
  return id === 'zh-cn' ? `${relative}重置` : `resets ${relative}`
}

function formatQueriedAt(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Host 缓存下查询时间可能滞后；Copilot 额度来自未公开接口。 */
export function footerNote(result: ProviderUsage | null): string {
  if (result?.kind === 'quota')
    return `${result.provider === 'github-copilot' ? 'GitHub 私有接口 · ' : ''}更新于 ${formatQueriedAt(result.queriedAt)}`
  return '仅当前 Provider 显示'
}

function WindowGrid({ windows, locale }: { windows: readonly UsageWindow[]; locale: string }) {
  return (
    <div className={panel.windows}>
      {windows.map((window) => {
        const left = remainingPct(window.usedPct)
        const color = remainingTone(left)
        const reset = formatReset(window.resetMs, locale)
        return (
          <div key={window.id} className={panel.window}>
            <div className={panel.windowName} title={window.label}>
              {window.label}
            </div>
            <div className={panel.windowValue} title={reset}>
              <span className={color}>{window.unlimited ? '不限量' : formatPct(left)}</span> · {reset}
            </div>
            {window.remaining != null && window.entitlement != null ? (
              <div className={panel.windowValue}>
                剩余 {window.remaining} / {window.entitlement}
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
  if (result?.kind === 'quota') return <WindowGrid windows={result.windows} locale={locale} />
  return (
    <dl className={panel.details}>
      <dt>{result === null ? '状态' : '原因'}</dt>
      <dd>{result === null ? '加载中…' : result.error}</dd>
    </dl>
  )
}

function UsageSummary({ label, result }: { label: string; result: ProviderUsage | null }) {
  if (result?.kind === 'unavailable') return <span className={toneStyles.err}>{label}用量不可用</span>
  if (result?.kind === 'quota')
    return (
      <>
        {label}
        {result.windows.map((window) => {
          const left = remainingPct(window.usedPct)
          return (
            <span
              key={window.id}
              className={pill.sep}
              title={window.label + '剩余 ' + (window.unlimited ? '不限量' : formatPct(left))}
            >
              {window.label}{' '}
              <span className={remainingTone(left)}>{window.unlimited ? '不限量' : formatPct(left)}</span>
            </span>
          )
        })}
      </>
    )
  return <>{label}用量…</>
}

function UsagePill({ provider, locale: store }: { provider: string; locale: LocaleRuntime }) {
  const { result, refreshing, refresh } = useUsage(provider)
  const locale = useActiveLocale(store)
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
  const label = USAGE_PROVIDERS[provider as keyof typeof USAGE_PROVIDERS] ?? provider
  const content = (
    <>
      <IconGaugeOutlineRegular />
      <span className={pill.label}>
        <UsageSummary label={label} result={result} />
      </span>
    </>
  )
  return (
    <span ref={anchor} className={pill.anchor}>
      {result === null ? (
        <Pill aria-label={label + '用量加载中'}>{content}</Pill>
      ) : (
        <Pill
          type="button"
          active={open}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label + '用量'}
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
            aria-label={label + '用量'}
            style={pos ?? undefined}
          >
            <div className={panel.title}>
              <span className={panel.titleLabel}>
                <IconGaugeOutlineRegular />
                {label}用量
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
                {refreshing ? '刷新中…' : '刷新'}
              </Button>
              <span className={panel.note}>{footerNote(result)}</span>
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
  if (provider === null || !Object.hasOwn(USAGE_PROVIDERS, provider)) return null
  return <UsagePill key={provider} provider={provider} locale={locale} />
}
