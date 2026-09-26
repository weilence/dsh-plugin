import { describe, expect, it } from 'vitest'
import { buildRoutes } from '../src/pi-ai/view'
import type { RouteDirectoryRow } from '../src/client/operations'

/** 官方 llm-pi-ai 的可配置目录：40 个内置 + 已配置的 route。 */
function directory(): RouteDirectoryRow[] {
  return [
    { provider: 'anthropic', displayName: 'anthropic', declared: false, active: false },
    { provider: 'openai', displayName: 'openai', declared: false, active: false },
    { provider: 'google', displayName: 'google', declared: false, active: false },
    { provider: 'zai-coding-cn', displayName: 'zai-coding-cn', declared: false, active: true },
    { provider: 'my-gateway', displayName: 'My Gateway', declared: true, active: true },
  ]
}

describe('面板只把「配置过」的 route 当作账号行', () => {
  it('未配置的内置 provider 标记为未配置，且不进入行列表', () => {
    const rows = buildRoutes(
      // 只有 zai-coding-cn 与 my-gateway 出现在合成后的 section 里
      {
        value: {
          providers: {
            'zai-coding-cn': { displayName: 'Z.ai' },
            'my-gateway': { displayName: 'My Gateway' },
          },
        },
        user: { providers: { 'my-gateway': { baseURL: 'https://g/v1' } } },
        base: {},
      },
      directory(),
      new Map(),
      new Map(),
    )
    const configured = rows.filter((row) => row.configured).map((row) => row.provider)
    const dormant = rows.filter((row) => !row.configured).map((row) => row.provider)
    expect(configured).toEqual(['zai-coding-cn', 'my-gateway'])
    expect(dormant).toEqual(['anthropic', 'openai', 'google'])
  })

  it('组合 base 提供的 route 也算已配置，且没有用户层 profile', () => {
    const rows = buildRoutes(
      {
        value: { providers: { anthropic: { displayName: 'Anthropic' } } },
        user: {},
        base: { providers: { anthropic: {} } },
      },
      directory(),
      new Map(),
      new Map(),
    )
    const anthropic = rows.find((row) => row.provider === 'anthropic')!
    expect(anthropic.configured).toBe(true)
    expect(anthropic.userProfile).toBeUndefined()
  })
})
