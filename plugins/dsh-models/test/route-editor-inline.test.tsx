import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FALLBACK_CHOICES } from '../src/pi-ai/choices'
import { buildRoutes } from '../src/pi-ai/view'
import { RouteEditor } from '../src/client/RouteEditor'
import { makeT } from './i18n'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  StateDot: () => null,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  IconPlusOutlineRegular: () => null,
}))

vi.mock('@dsh-plugins/client-ui', () => ({
  CardList: ({ items }: { items: readonly unknown[] }) => <div>模型卡片 {items.length}</div>,
  ExpandableCard: () => null,
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
  // 手写 route 没有安装目录（「获取模型」走 endpoint 询问）；内置 route 的
  // 目录非空（「获取模型」改从 models.dev 取更新清单）。
  const catalog = declared ? new Map() : new Map([['a', { name: '模型 A', contextWindow: 1000 }]])
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
    new Map([['gateway', catalog]]),
    new Map(),
  )[0]!
  return renderToStaticMarkup(
    createElement(RouteEditor, {
      route,
      choices: FALLBACK_CHOICES,
      catalog,
      keyConfigured: false,
      writable: true,
      busy: false,
      error: null,
      modelsDev: null,
      t: makeT(),
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
    expect(html).toContain('获取模型')
    expect(html).toContain('取消')
    expect(html).toContain('保存')
    expect(html).not.toContain('删除 Provider')
  })

  it('内置 Provider 的模型与自定义一样行内编辑，连接字段继承不显示', () => {
    const html = renderEditor(false)
    expect(html).toContain('模型卡片 1')
    expect(html).toContain('新增模型')
    // 目录 route 的「获取模型」从 models.dev 取更新的清单（Host 只会原样返回
    // pi-ai 安装目录），按钮照常显示。
    expect(html).toContain('获取模型')
    expect(html).not.toContain('Endpoint')
    expect(html).not.toContain('API 协议')
  })
})
