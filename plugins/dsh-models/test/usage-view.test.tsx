import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { footerNote, formatReset, UsageDetails } from '../src/client/usage/UsageChip'
import type { ProviderUsage } from '../src/usage/types'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({}))

function html(result: ProviderUsage | null, locale = 'zh') {
  return renderToStaticMarkup(createElement(UsageDetails, { result, locale }))
}

describe('按 Provider 显示真实用量语义', () => {
  it('智谱与 Codex 的已用百分比换算剩余，不把未知值当零', () => {
    expect(
      html({
        kind: 'quota',
        provider: 'zai-coding-cn',
        label: '智谱',
        windows: [
          { id: '5h', label: '5 小时', usedPct: 25, resetMs: null },
          { id: 'week', label: '每周', usedPct: null, resetMs: null },
        ],
        queriedAt: 0,
      }),
    ).toContain('75%')
    expect(
      html({
        kind: 'quota',
        provider: 'openai-codex',
        label: 'Codex',
        windows: [{ id: 'primary', label: '5 小时', usedPct: 90, resetMs: null }],
        queriedAt: 0,
      }),
    ).toContain('10%')
    expect(
      html({
        kind: 'quota',
        provider: 'zai-coding-cn',
        label: '智谱',
        windows: [{ id: 'unknown', label: '未知', usedPct: null, resetMs: null }],
        queriedAt: 0,
      }),
    ).not.toContain('100%')
  })

  it('Codex 达到限额时不再提示，仅以各窗口 0% 表达已达限额', () => {
    const content = html({
      kind: 'quota',
      provider: 'openai-codex',
      label: 'Codex',
      windows: [
        { id: 'primary', label: '5 小时', usedPct: 100, resetMs: null },
        { id: 'secondary', label: '每周', usedPct: 63, resetMs: null },
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

  it('Copilot 只显示历史计费次数，并明确不是实时剩余额度', () => {
    const content = html({
      kind: 'billing',
      provider: 'github-copilot',
      label: 'Copilot',
      payer: '个人 alice',
      payerKind: 'user',
      period: '2026-09',
      items: [{ label: 'GPT-5', requests: 123 }],
      queriedAt: 0,
    })
    expect(content).toContain('个人 alice')
    expect(content).toContain('GPT-5')
    expect(content).toContain('123 次')
    expect(content).toContain('个人计费报告不包含组织付费席位')
    expect(content).toContain('不代表订阅实时剩余额度')
    expect(content).not.toContain('%')
  })

  it('组织付款时说明报告可能包括其他成员', () => {
    const content = html({
      kind: 'billing',
      provider: 'github-copilot',
      label: 'Copilot',
      payer: '组织 example',
      payerKind: 'organization',
      period: '2026-09',
      items: [],
      queriedAt: 0,
    })
    expect(content).toContain('可能包含其他成员')
    expect(content).toContain('本期暂无计费请求')
  })

  it('脚注按数据语义区分：配额显示查询时间，计费说明是历史数据，失败解释空面板', () => {
    expect(
      footerNote({ kind: 'quota', provider: 'openai-codex', label: 'Codex', windows: [], queriedAt: 0 }),
    ).toMatch(/^更新于 \d{2}:\d{2}$/)
    expect(
      footerNote({
        kind: 'billing',
        provider: 'github-copilot',
        label: 'Copilot',
        payer: '个人 alice',
        payerKind: 'user',
        period: '2026-09',
        items: [],
        queriedAt: 0,
      }),
    ).toBe('GitHub Billing · 历史数据')
    expect(footerNote(null)).toBe('仅当前 Provider 显示')
  })

  it('重置时间跟随宿主语言：中文走 dayjs zh-cn，英文走 dayjs en，过期与缺失显示 —', () => {
    const now = new Date(2026, 9, 1, 9).getTime()
    expect(formatReset(now + 60_000, 'zh', now)).toBe('1 分钟内重置')
    expect(formatReset(now + 3 * 3_600_000, 'zh', now)).toBe('3 小时内重置')
    expect(formatReset(now + 6 * 86_400_000, 'zh', now)).toBe('6 天内重置')
    expect(formatReset(now + 40 * 86_400_000, 'zh', now)).toBe('1 个月内重置')
    expect(formatReset(now - 60_000, 'zh', now)).toBe('—')
    expect(formatReset(null, 'zh', now)).toBe('—')
    expect(formatReset(now + 3 * 3_600_000, 'en', now)).toBe('resets in 3 hours')
    expect(formatReset(now - 60_000, 'en', now)).toBe('—')
  })

  it('缺凭据时显示查询原因', () => {
    expect(
      html({ kind: 'unavailable', provider: 'github-copilot', label: 'Copilot', error: '缺少计费权限' }),
    ).toContain('缺少计费权限')
  })
})
