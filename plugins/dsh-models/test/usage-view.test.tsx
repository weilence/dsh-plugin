import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { UsageDetails, footerNote } from '../src/client/usage/UsageChip'
import { formatReset, providerName } from '../src/client/usage/locales'
import type { ProviderUsage } from '../src/usage/types'
import { makeT } from './i18n'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({}))

function html(result: ProviderUsage | null, active: 'zh' | 'en' = 'zh') {
  return renderToStaticMarkup(createElement(UsageDetails, { result, t: makeT(active), active }))
}

const ZHIPU_QUOTA: ProviderUsage = {
  kind: 'quota',
  provider: 'zai-coding-cn',
  windows: [
    { id: '5h', label: { kind: 'window', windowMins: 300 }, usedPct: 25, resetMs: null },
    { id: 'week', label: { kind: 'window', windowMins: 10080 }, usedPct: null, resetMs: null },
    { id: 'tools', label: { kind: 'toolCalls' }, usedPct: 90, resetMs: null },
  ],
  queriedAt: 0,
}

describe('按 Provider 显示真实用量语义', () => {
  it('智谱与 Codex 的已用百分比换算剩余，不把未知值当零', () => {
    expect(html(ZHIPU_QUOTA)).toContain('75%')
    expect(
      html({
        kind: 'quota',
        provider: 'openai-codex',
        windows: [{ id: 'p', label: { kind: 'window', windowMins: 300 }, usedPct: 90, resetMs: null }],
        queriedAt: 0,
      }),
    ).toContain('10%')
    expect(
      html({
        kind: 'quota',
        provider: 'zai-coding-cn',
        windows: [{ id: 'u', label: { kind: 'text', text: '未知' }, usedPct: null, resetMs: null }],
        queriedAt: 0,
      }),
    ).not.toContain('100%')
  })

  it('Codex 达到限额时不再提示，仅以各窗口 0% 表达已达限额', () => {
    const content = html({
      kind: 'quota',
      provider: 'openai-codex',
      windows: [
        { id: 'p', label: { kind: 'window', windowMins: 300 }, usedPct: 100, resetMs: null },
        { id: 's', label: { kind: 'window', windowMins: 10080 }, usedPct: 63, resetMs: null },
      ],
      queriedAt: 0,
    })
    expect(content).toContain('5 小时')
    expect(content).toContain('每周')
    expect(content).toContain('>0%</span>')
    expect(content).toContain('37%')
    expect(content).not.toContain('已达限额')
    expect(content).not.toContain('默认限额')
  })

  it('窗口标签跟随宿主语言，未知条目原样回退', () => {
    expect(html(ZHIPU_QUOTA)).toContain('工具调用')
    const en = html(ZHIPU_QUOTA, 'en')
    expect(en).toContain('5 hours')
    expect(en).toContain('Weekly')
    expect(en).toContain('Tool calls')
    expect(
      html(
        {
          ...ZHIPU_QUOTA,
          windows: [{ id: 'u', label: { kind: 'text', text: 'NEW_LIMIT' }, usedPct: null, resetMs: null }],
        },
        'en',
      ),
    ).toContain('NEW_LIMIT')
    expect(providerName('zai-coding-cn', 'zh')).toBe('智谱')
    expect(providerName('zai-coding-cn', 'en')).toBe('Zhipu')
    expect(providerName('example', 'en')).toBe('example')
  })

  it('英文重置时间用紧凑时长，窄列放得下', () => {
    const reset = (ms: number) =>
      html(
        {
          kind: 'quota',
          provider: 'zai-coding-cn',
          windows: [{ id: 'w', label: { kind: 'window', windowMins: 300 }, usedPct: 0, resetMs: ms }],
          queriedAt: 0,
        },
        'en',
      )
    expect(reset(Date.now() + 3 * 3_600_000)).toContain('resets in 3h')
  })

  it('Copilot 展示套餐剩余额度，不再显示账单历史记录', () => {
    const quota: ProviderUsage = {
      kind: 'quota',
      provider: 'github-copilot',
      windows: [
        {
          id: 'premium_interactions',
          label: { kind: 'premiumRequests' },
          usedPct: 30,
          resetMs: null,
          remaining: 210,
          entitlement: 300,
        },
      ],
      queriedAt: 0,
    }
    const content = html(quota)
    expect(content).toContain('高级请求')
    expect(content).toContain('70%')
    expect(content).toContain('剩余 210 / 300')
    expect(content).not.toContain('计费')
    const en = html(quota, 'en')
    expect(en).toContain('Premium requests')
    expect(en).toContain('210 / 300 left')
  })

  it('无限额度不显示伪造的百分比或余额', () => {
    const quota: ProviderUsage = {
      kind: 'quota',
      provider: 'github-copilot',
      windows: [
        {
          id: 'premium_interactions',
          label: { kind: 'premiumRequests' },
          usedPct: null,
          resetMs: null,
          unlimited: true,
        },
      ],
      queriedAt: 0,
    }
    expect(html(quota)).toContain('不限量')
    expect(html(quota)).not.toContain('剩余 0')
    expect(html(quota, 'en')).toContain('Unlimited')
  })

  it('脚注显示查询时间和 Copilot 私有接口数据来源', () => {
    const zh = makeT('zh')
    const en = makeT('en')
    expect(
      footerNote({ kind: 'quota', provider: 'openai-codex', windows: [], queriedAt: 0 }, zh, 'zh'),
    ).toMatch(/^更新于 \d{2}:\d{2}$/)
    expect(
      footerNote({ kind: 'quota', provider: 'github-copilot', windows: [], queriedAt: 0 }, zh, 'zh'),
    ).toMatch(/^GitHub 私有接口 · 更新于 \d{2}:\d{2}$/)
    expect(footerNote(null, zh, 'zh')).toBe('仅当前 Provider 显示')
    expect(footerNote(null, en, 'en')).toBe('Only shown for the current provider')
    expect(
      footerNote({ kind: 'quota', provider: 'github-copilot', windows: [], queriedAt: 0 }, en, 'en'),
    ).toMatch(/^GitHub private API · Updated \d{2}:\d{2}$/)
  })

  it('重置时间跟随宿主语言：中文走 dayjs zh-cn，英文走紧凑时长，过期与缺失显示 —', () => {
    const now = new Date(2026, 9, 1, 9).getTime()
    expect(formatReset(now + 60_000, 'zh', now)).toBe('1 分钟内重置')
    expect(formatReset(now + 3 * 3_600_000, 'zh', now)).toBe('3 小时内重置')
    expect(formatReset(now + 6 * 86_400_000, 'zh', now)).toBe('6 天内重置')
    expect(formatReset(now + 40 * 86_400_000, 'zh', now)).toBe('1 个月内重置')
    expect(formatReset(now - 60_000, 'zh', now)).toBe('—')
    expect(formatReset(null, 'zh', now)).toBe('—')
    expect(formatReset(now + 45_000, 'en', now)).toBe('resets in 45s')
    expect(formatReset(now + 90 * 60_000, 'en', now)).toBe('resets in 2h')
    expect(formatReset(now + 3 * 3_600_000, 'en', now)).toBe('resets in 3h')
    expect(formatReset(now + 6 * 86_400_000, 'en', now)).toBe('resets in 6d')
    expect(formatReset(now + 17 * 86_400_000, 'en', now)).toBe('resets in 2w')
    expect(formatReset(now + 40 * 86_400_000, 'en', now)).toBe('resets in 1mo')
    expect(formatReset(now - 60_000, 'en', now)).toBe('—')
  })

  it('缺凭据时按原因码翻译摘要并保留原始详情，未知详情原样展示', () => {
    const en = makeT('en')
    // 已知码：英文摘要 + 中文原始详情并存（详情是 Host 事实，不翻译）。
    expect(
      html(
        {
          kind: 'unavailable',
          provider: 'github-copilot',
          code: 'not_signed_in',
          detail: 'Copilot 尚未登录',
        },
        'en',
      ),
    ).toContain('Account sign-in required')
    expect(
      html(
        {
          kind: 'unavailable',
          provider: 'github-copilot',
          code: 'not_signed_in',
          detail: 'Copilot 尚未登录',
        },
        'en',
      ),
    ).toContain('Copilot 尚未登录')
    expect(
      html({ kind: 'unavailable', provider: 'github-copilot', code: 'not_configured', detail: '' }, 'en'),
    ).toContain('No credential configured')
    // unknown：详情即主文案，不猜不吞。
    expect(
      html({ kind: 'unavailable', provider: 'x', code: 'unknown', detail: 'missing token' }, 'en'),
    ).toContain('<dt>Reason</dt>')
    expect(
      html({ kind: 'unavailable', provider: 'x', code: 'unknown', detail: 'missing token' }, 'en'),
    ).toContain('missing token')
    const zh = makeT('zh')
    expect(
      html(
        {
          kind: 'unavailable',
          provider: 'openai-codex',
          code: 'authorization_changed',
          detail: 'credentials/record-updated during openai-codex query',
        },
        'zh',
      ),
    ).toContain('授权已更新，请重新查询')
  })
})
