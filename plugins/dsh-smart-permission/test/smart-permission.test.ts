import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_PRESET, apply } from '../src/index'

type Config = Parameters<typeof apply>[1]

type ToolListener = (
  exec: { name: string; agent?: { session: { id: string } } },
  next: () => Promise<unknown>,
) => Promise<unknown>

type ApprovalAnswerer = (
  req: { agent?: { session: { id: string } }; reason?: string },
  next: () => Promise<string>,
) => Promise<string>

const AGENT = { session: { id: 'session-a' } }
const askReason = (tool: string) =>
  `${'smart-permission:'} tool "${tool}" is not whitelisted under the "${DEFAULT_PRESET}" preset`

function install({ current = DEFAULT_PRESET, config }: { current?: string; config?: Config } = {}) {
  const listeners = new Map<string, { handler: unknown; options: unknown }>()
  const disposers: Array<() => void> = []
  const ctx = {
    permissionPresets: { current: () => current },
    on(event: string, handler: unknown, options?: unknown) {
      listeners.set(event, { handler, options })
      disposers.push(() => listeners.delete(event))
      return () => listeners.delete(event)
    },
    effect(setup: () => () => void) {
      disposers.push(setup())
    },
  }
  apply(ctx as unknown as Context, config)
  return {
    listener: (event: string) => listeners.get(event)?.handler as ToolListener | undefined,
    answerer: () => listeners.get('approval/request')?.handler as ApprovalAnswerer | undefined,
    answererOptions: () => listeners.get('approval/request')?.options,
    dispose: () => disposers.forEach((dispose) => dispose()),
  }
}

describe('白名单监听', () => {
  it('白名单工具直接放行', async () => {
    const plugin = install()
    const pass = vi.fn(async () => ({ kind: 'allow' }))
    const decision = await plugin.listener('tools/pre-execute')!({ name: 'read', agent: AGENT }, pass)
    expect(decision).toEqual({ kind: 'allow' })
    expect(pass).toHaveBeenCalledOnce()
  })

  it('非白名单工具返回 ask 决定，不执行 body', async () => {
    const plugin = install()
    const pass = vi.fn(async () => ({ kind: 'allow' }))
    const decision = (await plugin.listener('tools/pre-execute')!({ name: 'bash', agent: AGENT }, pass)) as {
      kind: string
      reason: string
    }
    expect(decision.kind).toBe('ask')
    expect(decision.reason).toBe(askReason('bash'))
    expect(pass).not.toHaveBeenCalled()
  })

  it('PTC 内层 tools.write 按 write 判定', async () => {
    const plugin = install()
    const pass = vi.fn(async () => ({ kind: 'allow' }))
    const decision = (await plugin.listener('tools/pre-execute')!(
      { name: 'tools.write', agent: AGENT },
      pass,
    )) as {
      kind: string
    }
    expect(decision.kind).toBe('ask')
    expect(pass).not.toHaveBeenCalled()
  })

  it('预设不匹配时完全委托', async () => {
    const plugin = install({ current: 'workspace-write' })
    const pass = vi.fn(async () => ({ kind: 'allow' }))
    await plugin.listener('tools/pre-execute')!({ name: 'bash', agent: AGENT }, pass)
    expect(pass).toHaveBeenCalledOnce()
  })

  it('会话内批准记忆：同名工具二次调用直接放行', async () => {
    const plugin = install()
    const listener = plugin.listener('tools/pre-execute')!
    await plugin.answerer()!({ agent: AGENT, reason: askReason('bash') }, async () => 'allowed-once')
    const pass = vi.fn(async () => ({ kind: 'allow' }))
    await listener({ name: 'bash', agent: AGENT }, pass)
    expect(pass).toHaveBeenCalledOnce()
  })

  it('dispose 撤回监听', () => {
    const plugin = install()
    plugin.dispose()
    expect(plugin.listener('tools/pre-execute')).toBeUndefined()
    expect(plugin.answerer()).toBeUndefined()
  })
})

describe('审批应答者', () => {
  it('已记忆的工具直接 allowed-once，不咨询人工', async () => {
    const plugin = install()
    const answerer = plugin.answerer()!
    await answerer({ agent: AGENT, reason: askReason('bash') }, async () => 'allowed-once')
    const human = vi.fn(async () => 'rejected')
    await expect(answerer({ agent: AGENT, reason: askReason('bash') }, human)).resolves.toBe('allowed-once')
    expect(human).not.toHaveBeenCalled()
  })

  it('allowed-once 记忆按会话隔离', async () => {
    const plugin = install()
    const answerer = plugin.answerer()!
    await answerer({ agent: AGENT, reason: askReason('bash') }, async () => 'allowed-once')
    const other = vi.fn(async () => 'allowed-once')
    await answerer({ agent: { session: { id: 'session-b' } }, reason: askReason('bash') }, other)
    expect(other).toHaveBeenCalledOnce()
  })

  it('拒绝不写入记忆', async () => {
    const plugin = install()
    const answerer = plugin.answerer()!
    await answerer({ agent: AGENT, reason: askReason('bash') }, async () => 'rejected')
    const human = vi.fn(async () => 'rejected')
    await expect(answerer({ agent: AGENT, reason: askReason('bash') }, human)).resolves.toBe('rejected')
    expect(human).toHaveBeenCalledOnce()
  })

  it('非本插件理由的审批请求原样委托', async () => {
    const plugin = install()
    const human = vi.fn(async () => 'allowed-once')
    await plugin.answerer()!(
      { agent: AGENT, reason: 'escalate sandbox to danger-full-access: user asked' },
      human,
    )
    expect(human).toHaveBeenCalledOnce()
  })

  it('rememberApprovedForSession: false 时不记忆', async () => {
    const plugin = install({ config: { rememberApprovedForSession: false } })
    const answerer = plugin.answerer()!
    await answerer({ agent: AGENT, reason: askReason('bash') }, async () => 'allowed-once')
    const human = vi.fn(async () => 'allowed-once')
    await answerer({ agent: AGENT, reason: askReason('bash') }, human)
    expect(human).toHaveBeenCalledOnce()
  })

  it('应答者以 prepend 注册', () => {
    const plugin = install()
    expect(plugin.answererOptions()).toEqual({ prepend: true })
  })
})
