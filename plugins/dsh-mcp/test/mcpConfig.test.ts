/** mcpConfig：校验归一与编辑合并（与官方 mcp-client Config schema 对齐）。 */

import { describe, expect, it } from 'vitest'
import { ConfigError, endpointOf, normalizeDraft } from '../src/mcpConfig'

describe('normalizeDraft', () => {
  it('stdio：必填 command，args/env/cwd 可选并剔除空集合', () => {
    expect(
      normalizeDraft({
        transport: 'stdio',
        serverName: 'context7',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        env: { API_KEY: 'k' },
        cwd: 'D:/work',
      }),
    ).toEqual({
      transport: 'stdio',
      serverName: 'context7',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: { API_KEY: 'k' },
      cwd: 'D:/work',
    })
    expect(normalizeDraft({ transport: 'stdio', serverName: 'a-b', command: 'node', env: {} })).toEqual({
      transport: 'stdio',
      serverName: 'a-b',
      command: 'node',
    })
  })

  it('streamable-http：必填 http(s) url，headers 可选', () => {
    expect(
      normalizeDraft({ transport: 'streamable-http', serverName: 'demo', url: 'https://x.example/mcp' }),
    ).toEqual({ transport: 'streamable-http', serverName: 'demo', url: 'https://x.example/mcp' })
    expect(() =>
      normalizeDraft({ transport: 'streamable-http', serverName: 'demo', url: 'ftp://x' }),
    ).toThrow(ConfigError)
    expect(() =>
      normalizeDraft({ transport: 'streamable-http', serverName: 'demo', url: 'not a url' }),
    ).toThrow(ConfigError)
  })

  it('serverName 沿用官方约束', () => {
    expect(() => normalizeDraft({ transport: 'stdio', serverName: 'has space', command: 'x' })).toThrow(
      ConfigError,
    )
    expect(() => normalizeDraft({ transport: 'stdio', serverName: 'x'.repeat(33), command: 'x' })).toThrow(
      ConfigError,
    )
    expect(() => normalizeDraft({ transport: 'stdio', command: 'x' })).toThrow(ConfigError)
  })

  it('拒绝未知键与坏类型', () => {
    expect(() =>
      normalizeDraft({ transport: 'stdio', serverName: 'a', command: 'x', reconnect: {} }),
    ).toThrow('未知字段')
    expect(() =>
      normalizeDraft({ transport: 'stdio', serverName: 'a', command: 'x', args: ['-y', 3] }),
    ).toThrow(ConfigError)
    expect(() =>
      normalizeDraft({ transport: 'stdio', serverName: 'a', command: 'x', toolCallTimeoutMs: 0 }),
    ).toThrow(ConfigError)
    expect(() =>
      normalizeDraft({ transport: 'stdio', serverName: 'a', command: 'x', failOnStartupError: 'yes' }),
    ).toThrow(ConfigError)
  })
})

describe('endpointOf', () => {
  it('stdio 拼命令行，http 取 url', () => {
    expect(endpointOf({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] })).toBe('npx -y pkg')
    expect(endpointOf({ transport: 'streamable-http', url: 'https://x/mcp' })).toBe('https://x/mcp')
    expect(endpointOf({})).toBe('')
  })
})
