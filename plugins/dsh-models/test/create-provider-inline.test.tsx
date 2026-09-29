import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CreateProviderForm } from '../src/client/CreateProviderForm'
import type { SignInView } from '../src/client/SignInCard'

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

function renderForm(
  dormantProviders: readonly string[],
  signInView?: (provider: string) => SignInView | null,
) {
  return renderToStaticMarkup(
    createElement(CreateProviderForm, {
      busy: false,
      error: null,
      dormantProviders,
      catalog: null,
      modelsDevLoading: false,
      modelsDevError: null,
      routes: [],
      protocols: ['openai-completions'],
      signInView,
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

  it('oauth-only 内置 Provider 渲染登录卡并隐藏 API Key 字段', () => {
    const html = renderForm(['openai-codex'], (provider) =>
      provider === 'openai-codex' ? { card: <div>登录卡</div>, replacesApiKey: true } : null,
    )
    expect(html).toContain('登录卡')
    expect(html).not.toContain('API Key')
  })

  it('双形态 Provider 登录卡与 API Key 字段并排', () => {
    const html = renderForm(['openrouter'], (provider) =>
      provider === 'openrouter' ? { card: <div>登录卡</div>, replacesApiKey: false } : null,
    )
    expect(html).toContain('登录卡')
    expect(html).toContain('API Key')
  })
})
