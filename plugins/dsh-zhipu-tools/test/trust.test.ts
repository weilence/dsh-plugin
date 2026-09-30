import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'

function setup(resolve: (name: string) => Promise<unknown>) {
  const logs: string[] = []
  const plugin = vi.fn(async (_entry: unknown, _config: unknown) => {})
  const ctx = {
    credentials: { resolve },
    plugin,
    logger: { error: (message: string) => logs.push(message), info: (message: string) => logs.push(message) },
  }
  return { ctx, plugin, logs }
}

describe('智谱 MCP 挂载', () => {
  it('没有凭据时保持激活，不挂工具', async () => {
    const { ctx, plugin, logs } = setup(async () => undefined)
    await apply(ctx as never)
    expect(plugin).not.toHaveBeenCalled()
    expect(logs.some((line) => line.includes('未配置'))).toBe(true)
  })

  it('按优先级解析 key，挂载两个官方工具', async () => {
    const { ctx, plugin } = setup(async (name) =>
      name === 'ZAI_CODING_CN_API_KEY' ? { value: 'secret' } : undefined,
    )
    await apply(ctx as never)
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

  it('凭据解析失败携带具体原因', async () => {
    const { ctx, logs } = setup(async () => {
      throw new Error('凭据服务离线')
    })
    await apply(ctx as never)
    expect(logs.some((line) => line.includes('凭据服务离线'))).toBe(true)
  })
})
