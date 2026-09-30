import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { UsageDetails } from '../src/client/usage/UsageChip'
import type { ProviderUsage } from '../src/usage/types'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({}))

function html(result: ProviderUsage | null) {
  return renderToStaticMarkup(createElement(UsageDetails, { result }))
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
        windows: [{ id: 'primary', label: 'Codex · 5 小时', usedPct: 90, resetMs: null }],
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

  it('Codex 不能仅凭剩余百分比推断当前是否允许请求', () => {
    const content = html({
      kind: 'quota',
      provider: 'openai-codex',
      label: 'Codex',
      allowed: false,
      limitReached: true,
      windows: [
        {
          id: 'main',
          label: '5 小时',
          usedPct: 80,
          resetMs: null,
          allowed: false,
          limitReached: true,
        },
      ],
      queriedAt: 0,
    })
    expect(content).toContain('20%')
    expect(content).toContain('默认限额已达限额')
    expect(content).toContain('5 小时 · 已达限额')
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

  it('缺凭据时显示查询原因', () => {
    expect(
      html({ kind: 'unavailable', provider: 'github-copilot', label: 'Copilot', error: '缺少计费权限' }),
    ).toContain('缺少计费权限')
  })
})
