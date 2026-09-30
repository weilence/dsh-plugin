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

  it('Copilot 展示套餐剩余额度，不再显示账单历史记录', () => {
    const content = html({
      kind: 'quota',
      provider: 'github-copilot',
      label: 'Copilot',
      windows: [
        {
          id: 'premium_interactions',
          label: '高级请求',
          usedPct: 30,
          resetMs: null,
          remaining: 210,
          entitlement: 300,
        },
      ],
      queriedAt: 0,
    })
    expect(content).toContain('高级请求')
    expect(content).toContain('70%')
    expect(content).toContain('剩余 210 / 300')
    expect(content).not.toContain('计费')
  })

  it('无限额度不显示伪造的百分比或余额', () => {
    const content = html({
      kind: 'quota',
      provider: 'github-copilot',
      label: 'Copilot',
      windows: [
        { id: 'premium_interactions', label: '高级请求', usedPct: null, resetMs: null, unlimited: true },
      ],
      queriedAt: 0,
    })
    expect(content).toContain('不限量')
    expect(content).not.toContain('剩余 0')
  })

  it('脚注显示查询时间和 Copilot 私有接口数据来源', () => {
    expect(
      footerNote({ kind: 'quota', provider: 'openai-codex', label: 'Codex', windows: [], queriedAt: 0 }),
    ).toMatch(/^更新于 \d{2}:\d{2}$/)
    expect(
      footerNote({ kind: 'quota', provider: 'github-copilot', label: 'Copilot', windows: [], queriedAt: 0 }),
    ).toMatch(/^GitHub 私有接口 · 更新于 \d{2}:\d{2}$/)
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
      html({
        kind: 'unavailable',
        provider: 'github-copilot',
        label: 'Copilot',
        error: 'Copilot 尚未登录 GitHub',
      }),
    ).toContain('Copilot 尚未登录 GitHub')
  })
})
