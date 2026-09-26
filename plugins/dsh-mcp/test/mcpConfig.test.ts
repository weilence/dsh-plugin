/** mcpConfig：校验归一与编辑合并（与官方 mcp-client Config schema 对齐）。 */

import { describe, expect, it } from 'vitest'
import { ConfigError, endpointOf, mergeForEdit, normalizeDraft } from '../src/mcpConfig'

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

describe('mergeForEdit', () => {
  it('insert 底座保留未知键，生效配置与草稿依次覆盖', () => {
    expect(
      mergeForEdit(
        [
          {
            transport: 'stdio',
            serverName: 'a',
            command: 'old',
            reconnect: { enabled: false },
            maxInstructionBytes: 1024,
          },
          { transport: 'stdio', serverName: 'a', command: 'override' },
        ],
        { transport: 'stdio', serverName: 'a', command: 'new' },
      ),
    ).toEqual({
      transport: 'stdio',
      serverName: 'a',
      command: 'new',
      reconnect: { enabled: false },
      maxInstructionBytes: 1024,
    })
  })

  it('切换传输形态时丢弃另一形态的专属键', () => {
    expect(
      mergeForEdit(
        [
          {
            transport: 'stdio',
            serverName: 'a',
            command: 'node',
            args: ['x'],
            cwd: 'c',
            reconnect: { enabled: true },
          },
        ],
        { transport: 'streamable-http', serverName: 'a', url: 'https://x/mcp' },
      ),
    ).toEqual({
      transport: 'streamable-http',
      serverName: 'a',
      url: 'https://x/mcp',
      reconnect: { enabled: true },
    })
    expect(
      mergeForEdit(
        [{ transport: 'streamable-http', serverName: 'a', url: 'https://x/mcp', headers: { A: 'b' } }],
        { transport: 'stdio', serverName: 'a', command: 'node' },
      ),
    ).toEqual({ transport: 'stdio', serverName: 'a', command: 'node' })
  })
})

describe('endpointOf', () => {
  it('stdio 拼命令行，http 取 url', () => {
    expect(endpointOf({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] })).toBe('npx -y pkg')
    expect(endpointOf({ transport: 'streamable-http', url: 'https://x/mcp' })).toBe('https://x/mcp')
    expect(endpointOf({})).toBe('')
  })
})
