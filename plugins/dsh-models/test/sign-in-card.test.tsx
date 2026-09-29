import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SignInCard, activePromptOf } from '../src/client/SignInCard'
import type { AuthState } from '../src/client/store'
import type { AuthSequencedEvent } from '../src/client/operations'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
  StateDot: () => <span data-dot="" />,
  Input: (props: { value?: string; type?: string; placeholder?: string }) => (
    <input value={props.value} type={props.type} placeholder={props.placeholder} readOnly />
  ),
}))

vi.mock('@dsh-plugins/client-ui', () => ({
  IssueList: ({ issues }: { issues: { message: string }[] }) => (
    <div>{issues.map((issue) => issue.message)}</div>
  ),
  fieldInputCls: () => '',
}))

function eventsOf(...rows: AuthSequencedEvent[]): readonly AuthSequencedEvent[] {
  return rows
}

describe('activePromptOf 未应答问题判定', () => {
  it('最后一条 prompt 且无同 id answered / withdrawn 时激活', () => {
    const prompt = activePromptOf(
      eventsOf(
        { seq: 1, kind: 'notice', message: 'go' },
        { seq: 2, kind: 'prompt', promptId: 2, prompt: { kind: 'text', message: '输入码' } },
      ),
    )
    expect(prompt?.promptId).toBe(2)
  })

  it('answered / withdrawn 之后不再激活', () => {
    expect(
      activePromptOf(
        eventsOf(
          { seq: 1, kind: 'prompt', promptId: 1, prompt: { kind: 'text', message: 'a' } },
          { seq: 2, kind: 'answered', promptId: 1 },
          { seq: 3, kind: 'prompt', promptId: 3, prompt: { kind: 'text', message: 'b' } },
          { seq: 4, kind: 'withdrawn', promptId: 3 },
        ),
      ),
    ).toBeUndefined()
  })
})

function authOf(overrides: Partial<AuthState> = {}): AuthState {
  return { flows: {}, records: {}, attempt: null, ...overrides }
}

describe('SignInCard', () => {
  const flow = { label: 'OpenAI Codex', methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }] }

  it('未登录：显示订阅说明与登录入口', () => {
    const html = renderToStaticMarkup(
      createElement(SignInCard, {
        provider: 'openai-codex',
        flow,
        auth: authOf({ records: { 'openai-codex': { configured: false } } }),
        replacesApiKey: true,
        onBegin: () => {},
        onAnswer: () => {},
        onDecline: () => {},
        onCancel: () => {},
      }),
    )
    expect(html).toContain('未授权')
    expect(html).toContain('登录')
    expect(html).toContain('不使用 API Key')
  })

  it('已授权：入口变为重新登录', () => {
    const html = renderToStaticMarkup(
      createElement(SignInCard, {
        provider: 'openai-codex',
        flow,
        auth: authOf({ records: { 'openai-codex': { configured: true, kind: 'grant' } } }),
        replacesApiKey: true,
        onBegin: () => {},
        onAnswer: () => {},
        onDecline: () => {},
        onCancel: () => {},
      }),
    )
    expect(html).toContain('已授权')
    expect(html).toContain('重新登录')
  })

  it('进行中：通知里的授权链接与设备码可选中复制，问题表单就位', () => {
    const html = renderToStaticMarkup(
      createElement(SignInCard, {
        provider: 'openai-codex',
        flow,
        auth: authOf({
          attempt: {
            provider: 'openai-codex',
            running: true,
            events: [
              {
                seq: 1,
                kind: 'notice',
                message: '输入验证码',
                url: 'https://auth.example/device',
                code: 'ABCD',
              },
              {
                seq: 2,
                kind: 'prompt',
                promptId: 2,
                prompt: {
                  kind: 'select',
                  message: '选择登录方式',
                  options: [{ id: 'browser', label: '浏览器' }],
                },
              },
            ],
          },
        }),
        replacesApiKey: true,
        onBegin: () => {},
        onAnswer: () => {},
        onDecline: () => {},
        onCancel: () => {},
      }),
    )
    expect(html).toContain('href="https://auth.example/device"')
    expect(html).toContain('ABCD')
    expect(html).toContain('选择登录方式')
    expect(html).toContain('取消登录')
  })

  it('尝试已结束：结果行可回看，登录入口立即还给用户', () => {
    const html = renderToStaticMarkup(
      createElement(SignInCard, {
        provider: 'github-copilot',
        flow,
        auth: authOf({
          attempt: {
            provider: 'github-copilot',
            running: false,
            events: [{ seq: 1, kind: 'outcome', status: 'cancelled' }],
          },
        }),
        replacesApiKey: true,
        onBegin: () => {},
        onAnswer: () => {},
        onDecline: () => {},
        onCancel: () => {},
      }),
    )
    expect(html).toContain('登录已取消')
    expect(html).toContain('再次登录')
    expect(html).not.toContain('取消登录')
  })

  it('其他 Provider 的尝试不在本卡渲染', () => {
    const html = renderToStaticMarkup(
      createElement(SignInCard, {
        provider: 'openai-codex',
        flow,
        auth: authOf({
          attempt: {
            provider: 'github-copilot',
            running: true,
            events: [{ seq: 1, kind: 'notice', message: '别家的尝试' }],
          },
        }),
        replacesApiKey: true,
        onBegin: () => {},
        onAnswer: () => {},
        onDecline: () => {},
        onCancel: () => {},
      }),
    )
    expect(html).not.toContain('别家的尝试')
    expect(html).toContain('登录')
  })
})
