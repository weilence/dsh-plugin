import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { apply } from '../src/client'
import { makeT } from './i18n'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null }))
vi.mock('@dsh-plugins/client-ui/tone', () => ({ ToneChip: () => null }))

const { notifications } = vi.hoisted(() => ({ notifications: [] as { title: string; body: string }[] }))

class FakeNotification {
  static permission = 'granted'
  onclick: (() => void) | null = null
  onshow: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(title: string, options: { body: string }) {
    notifications.push({ title, body: options.body })
  }
  close() {}
}

function setup() {
  const list = {
    byId: {
      main: { displayTitle: '主会话' },
      child: { displayTitle: '子代理', parentId: 'main', origin: 'subagent' },
      addressedChild: { displayTitle: '已识别的子代理', parentId: 'main' },
      fork: { displayTitle: '分叉主会话', parentId: 'main' },
    },
  }
  let statusHandler: (sessionId: SessionId, running: boolean) => void = () => {}
  let pendingHandler: () => void = () => {}
  let pending = new Map<SessionId, SessionStatus>()
  const ctx = {
    remote: {
      $on: (_event: string, handler: typeof statusHandler) => {
        statusHandler = handler
        return () => {}
      },
    },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => pending,
        subscribe: (handler: () => void) => {
          pendingHandler = handler
          return () => {}
        },
      },
    },
    sessions: {
      list: { getSnapshot: () => list },
      subagentAddress: (id: SessionId) => (id === 'addressedChild' ? { parentSessionId: 'main' } : undefined),
    },
    uiWorkspace: { openSession: vi.fn() },
    effect: (callback: () => unknown) => {
      callback()
    },
    // locale 服务替身：register 丢弃、bind 返回真实的 zh 取词（通知正文断言用）。
    locale: { register: () => () => {}, bind: () => makeT() },
    slots: { inject: vi.fn() },
  } as unknown as Context
  apply(ctx)
  return {
    status: (id: string, running: boolean) => statusHandler(id as SessionId, running),
    pending: (id: string, key: string, kind = 'question') => {
      pending = new Map(pending)
      pending.set(id as SessionId, {
        running: true,
        completionUnread: false,
        pendingInteraction: { key, kind, sessionId: id as SessionId },
      })
      pendingHandler()
    },
  }
}

beforeEach(() => {
  notifications.length = 0
  vi.stubGlobal('Notification', FakeNotification)
  vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
})

afterEach(() => vi.unstubAllGlobals())

describe('通知仅限主代理', () => {
  it('子代理完成及提问均静默，主代理完成及提问正常通知', () => {
    const events = setup()
    events.status('child', false)
    events.pending('child', 'question:child')
    events.pending('child', 'approval:child', 'approval')
    expect(notifications).toEqual([])
    events.status('main', false)
    events.pending('main', 'question:main')
    events.pending('main', 'approval:main', 'approval')
    expect(notifications).toEqual([
      { title: 'DSH · 主会话', body: '模型处理已完成' },
      { title: 'DSH · 主会话', body: '等待您的回答' },
      { title: 'DSH · 主会话', body: '等待批准：工具' },
    ])
  })

  it('未进入列表或只从子代理地址识别出的会话也不通知', () => {
    const events = setup()
    events.status('unknown', false)
    events.pending('unknown', 'question:unknown')
    events.status('addressedChild', false)
    events.pending('addressedChild', 'question:addressed')
    expect(notifications).toEqual([])
  })

  it('普通分叉会话虽有 parentId，仍作为主代理通知', () => {
    const events = setup()
    events.status('fork', false)
    expect(notifications).toEqual([{ title: 'DSH · 分叉主会话', body: '模型处理已完成' }])
  })
})
