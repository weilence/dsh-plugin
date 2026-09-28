import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CreateProviderForm } from '../src/client/CreateProviderForm'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  Pill: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

vi.mock('@dsh-plugins/client-ui', () => ({
  IssueList: () => null,
  SelectField: ({ label }: { label: string }) => <div>{label}</div>,
  TextField: ({ label }: { label: string }) => <div>{label}</div>,
}))

vi.mock('../src/client/ModelsDevImport', () => ({
  ModelsDevImport: () => <div>自定义 Provider 字段</div>,
}))

function renderForm(dormantProviders: readonly string[]) {
  return renderToStaticMarkup(
    createElement(CreateProviderForm, {
      busy: false,
      error: null,
      knownProviders: [],
      dormantProviders,
      catalog: null,
      modelsDevLoading: false,
      modelsDevError: null,
      routes: [],
      onCancel: () => {},
      onLoadCatalog: () => {},
      onCreate: async () => true,
      onSaveProfile: async () => true,
      onFetchModels: async () => [],
      onError: () => {},
    }),
  )
}

describe('Provider 行内新建', () => {
  it('有可选内置 Provider 时在卡片展开体展示字段和操作按钮', () => {
    const html = renderForm(['anthropic'])
    expect(html).toContain('使用内置 Provider')
    expect(html).toContain('自定义 Provider')
    expect(html).toContain('内置 Provider')
    expect(html).toContain('API Key')
    expect(html).toContain('取消')
    expect(html).toContain('创建')
    expect(html).not.toContain('自定义 Provider 字段')
  })

  it('没有未配置内置 Provider 时直接展示自定义字段和操作按钮', () => {
    const html = renderForm([])
    expect(html).toContain('自定义 Provider 字段')
    expect(html).toContain('取消')
    expect(html).toContain('创建')
    expect(html).not.toContain('内置 Provider</div>')
  })
})
