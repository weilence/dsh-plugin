import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FALLBACK_CHOICES } from '../src/pi-ai/choices'
import { buildRoutes } from '../src/pi-ai/view'
import { RouteEditor } from '../src/client/RouteEditor'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  StateDot: () => null,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  IconPlusOutlineRegular: () => null,
}))

vi.mock('@dsh-plugins/client-ui', () => ({
  CardList: ({ items }: { items: readonly unknown[] }) => <div>模型卡片 {items.length}</div>,
  ExpandableCard: () => null,
  ModelTable: ({ rows }: { rows: readonly unknown[] }) => <div>目录模型 {rows.length}</div>,
  SelectField: ({
    label,
    value,
    options,
  }: {
    label: string
    value: string
    options: readonly { value: string; label: string; disabled?: boolean }[]
  }) => (
    <label>
      {label}
      <select defaultValue={value}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  ),
  TextField: ({ label }: { label: string }) => <div>{label}</div>,
  IssueList: () => null,
  formatTokenCount: String,
}))

function renderEditor(declared: boolean) {
  const route = buildRoutes(
    {
      user: {
        providers: declared
          ? { gateway: { api: 'openai-completions', baseURL: 'https://example.com', models: [{ id: 'a' }] } }
          : { gateway: { displayName: 'Gateway' } },
      },
      value: {},
      base: {},
    },
    [{ provider: 'gateway', displayName: 'Gateway', declared, active: true }],
    new Map([['gateway', new Map([['a', { name: '模型 A', contextWindow: 1000 }]])]]),
    new Map(),
  )[0]!
  return renderToStaticMarkup(
    createElement(RouteEditor, {
      route,
      choices: FALLBACK_CHOICES,
      catalog: new Map(),
      keyConfigured: false,
      writable: true,
      busy: false,
      error: null,
      modelsDev: null,
      onLoadModelsDev: async () => null,
      onDirtyChange: () => {},
      onCancel: () => {},
      onExit: () => {},
      onFetchModels: async () => [],
      onSave: async () => true,
    }),
  )
}

describe('Provider 行内编辑', () => {
  it('连接字段和模型卡片与保存按钮直接显示在展开体，不使用弹窗', () => {
    const html = renderEditor(true)
    expect(html).toContain('API 协议')
    expect(html).toContain('默认推理等级')
    expect(html.indexOf('API 协议')).toBeLessThan(html.indexOf('默认推理等级'))
    const selector = html.match(/默认推理等级[^]*?<\/select>/)?.[0]
    expect(selector).toContain('<option value="" selected="">继承默认</option>')
    for (const level of FALLBACK_CHOICES.thinkingLevels) {
      expect(selector).toContain(`<option value="${level}">${level}</option>`)
    }
    expect(html).toContain('模型卡片 1')
    expect(html).toContain('新增模型')
    expect(html).toContain('取消')
    expect(html).toContain('保存')
    expect(html).not.toContain('删除 Provider')
  })

  it('内置 Provider 仍可查看目录模型', () => {
    const html = renderEditor(false)
    expect(html).toContain('目录模型 1')
    expect(html).not.toContain('获取模型')
  })
})
