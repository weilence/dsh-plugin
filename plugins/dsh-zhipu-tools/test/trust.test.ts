import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'

function setup(resolve: (name: string) => Promise<unknown>) {
  const logs: string[] = []
  const plugin = vi.fn(async (_entry: unknown, _config: unknown) => {})
  const registerSearchProvider = vi.fn((_provider: unknown) => {})
  const ctx = {
    credentials: { resolve },
    plugin,
    web: { registerSearchProvider },
    // 开关路由在 apply 时注册；假桩只记录不响应。
    effect: (register: () => unknown) => register(),
    webServer: {
      host: '127.0.0.1',
      register: () => () => {},
    },
    get: () => undefined,
    logger: { error: (message: string) => logs.push(message), info: (message: string) => logs.push(message) },
  }
  return { ctx, plugin, registerSearchProvider, logs }
}

describe('智谱搜索提供者和 Reader MCP', () => {
  it('没有凭据时仍注册搜索提供者，调用时明确报错', async () => {
    const { ctx, plugin, registerSearchProvider, logs } = setup(async () => undefined)
    await apply(ctx as never)
    expect(plugin).not.toHaveBeenCalled()
    const provider = registerSearchProvider.mock.calls[0]?.[0] as {
      id: string
      search: (request: { query: string }) => Promise<unknown>
    }
    expect(provider.id).toBe('zhipu')
    await expect(provider.search({ query: 'hello' })).rejects.toThrow('未配置智谱 Coding Plan API Key')
    expect(logs.some((line) => line.includes('未配置'))).toBe(true)
  })

  it('按优先级解析 key，挂载两个官方 MCP 工具', async () => {
    const { ctx, plugin, registerSearchProvider } = setup(async (name) =>
      name === 'ZAI_CODING_CN_API_KEY' ? { value: 'secret' } : undefined,
    )
    await apply(ctx as never)
    expect(registerSearchProvider).toHaveBeenCalledTimes(1)
    expect(plugin).toHaveBeenCalledTimes(2)
    expect(plugin.mock.calls[0]?.[1]).toMatchObject({
      serverName: 'zhipu_search',
      headers: { Authorization: 'Bearer secret' },
    })
    expect(plugin.mock.calls[1]?.[1]).toMatchObject({
      serverName: 'zhipu_reader',
      headers: { Authorization: 'Bearer secret' },
    })
  })

  it('首选凭据解析故障不会静默切换到次选账户', async () => {
    const resolve = vi.fn(async (name: string) => {
      if (name === 'ZAI_CODING_CN_API_KEY') throw new Error('凭据服务离线')
      return { value: 'another-account-key' }
    })
    const { ctx, plugin, registerSearchProvider, logs } = setup(resolve)
    await apply(ctx as never)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(plugin).not.toHaveBeenCalled()
    const provider = registerSearchProvider.mock.calls[0]?.[0] as {
      search: (request: { query: string }) => Promise<unknown>
    }
    await expect(provider.search({ query: 'hello' })).rejects.toThrow('凭据服务离线')
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(logs.some((line) => line.includes('凭据服务离线'))).toBe(true)
  })

  it('首选凭据确实缺席时才尝试次选', async () => {
    const { ctx, plugin } = setup(async (name) =>
      name === 'ZAI_API_KEY' ? { value: 'fallback-key' } : undefined,
    )
    await apply(ctx as never)
    expect(plugin.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer fallback-key' },
    })
  })
})
