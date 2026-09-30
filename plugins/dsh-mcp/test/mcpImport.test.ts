import { describe, expect, it } from 'vitest'
import { ConfigError, extrasOf, parseMcpJsonText } from '../src/mcpConfig'
import { messageText } from '../src/client/locales'
import { makeT } from './i18n'

describe('parseMcpJsonText', () => {
  it('解析 mcpServers 包装的多个服务器并透传未知键', () => {
    const result = parseMcpJsonText(
      JSON.stringify({
        mcpServers: {
          context7: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp'],
            env: { API_KEY: 'k' },
            reconnect: { retries: 3 },
          },
          remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Tenant': 'a' } },
        },
      }),
    )
    expect(result.problems).toEqual([])
    expect(result.entries).toHaveLength(2)
    const [first, second] = result.entries
    expect(first.serverName).toBe('context7')
    expect(first.draft).toEqual({
      transport: 'stdio',
      serverName: 'context7',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: { API_KEY: 'k' },
    })
    expect(first.extras).toEqual({ reconnect: { retries: 3 } })
    expect(second.serverName).toBe('remote')
    expect(second.draft.transport).toBe('streamable-http')
    expect(second.draft.url).toBe('https://mcp.example.com/mcp')
  })

  it('单个服务器对象：从 command / URL 自动推导名称，无需手填', () => {
    const byCommand = parseMcpJsonText(JSON.stringify({ command: 'uvx', args: ['mcp-server'] }))
    expect(byCommand.entries[0]?.serverName).toBe('uvx')
    expect(byCommand.entries[0]?.draft.transport).toBe('stdio')
    expect(byCommand.entries[0]?.notes[0]).toContain('已自动命名')

    const byUrl = parseMcpJsonText(JSON.stringify({ url: 'https://mcp.example.com/mcp' }))
    expect(byUrl.entries[0]?.serverName).toBe('mcp-example-com')
    expect(byUrl.entries[0]?.draft.transport).toBe('streamable-http')

    const byWindowsPath = parseMcpJsonText(JSON.stringify({ command: 'C:\\tools\\server.exe' }))
    expect(byWindowsPath.entries[0]?.serverName).toBe('server')
  })

  it('{"名称": {...}} 直接映射：键名即服务器名', () => {
    const result = parseMcpJsonText(
      JSON.stringify({
        context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      }),
    )
    expect(result.problems).toEqual([])
    expect(result.entries.map((entry) => entry.serverName)).toEqual(['context7', 'remote'])
    expect(result.entries[1]?.draft.transport).toBe('streamable-http')
  })

  it('直接映射里的非对象值进入 problems 而不是整体失败', () => {
    const result = parseMcpJsonText(JSON.stringify({ good: { command: 'x' }, bad: 1 }))
    expect(result.entries.map((entry) => entry.serverName)).toEqual(['good'])
    expect(result.problems[0]?.name).toBe('bad')
  })

  it('type 缺失时按 command / url 推断传输形态', () => {
    const result = parseMcpJsonText(
      JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { url: 'https://x/mcp' } } }),
    )
    expect(result.entries[0]?.draft.transport).toBe('stdio')
    expect(result.entries[1]?.draft.transport).toBe('streamable-http')
  })

  it('sse 归一为 streamable-http 并提示已弃用', () => {
    const result = parseMcpJsonText(
      JSON.stringify({ mcpServers: { a: { type: 'sse', url: 'https://x/sse' } } }),
    )
    expect(result.entries[0]?.draft.transport).toBe('streamable-http')
    expect(result.entries[0]?.notes[0]).toContain('已弃用')
  })

  it('${PLUGIN_ROOT} 类占位符报为问题条目', () => {
    const result = parseMcpJsonText(
      JSON.stringify({
        mcpServers: { a: { type: 'stdio', command: './bin/x', args: ['${PLUGIN_ROOT}/c'] } },
      }),
    )
    expect(result.entries).toHaveLength(0)
    expect(messageText(result.problems[0]!.message, makeT())).toContain('占位符')
  })

  it('非法 serverName 键与缺少必填字段进入 problems', () => {
    const result = parseMcpJsonText(
      JSON.stringify({
        mcpServers: { 'bad name!': { command: 'x' }, b: { type: 'stdio' }, c: { type: 'http' } },
      }),
    )
    expect(result.entries).toHaveLength(0)
    expect(result.problems.map((problem) => messageText(problem.message, makeT()))).toEqual([
      '名称「bad name!」需匹配 ^[A-Za-z0-9_-]{1,32}$',
      'stdio 服务器缺少 command',
      'HTTP 服务器缺少 url',
    ])
  })

  it('跨传输形态的专属键被忽略并给出提示', () => {
    const result = parseMcpJsonText(
      JSON.stringify({ mcpServers: { a: { type: 'http', url: 'https://x/mcp', command: 'x' } } }),
    )
    expect(result.entries[0]?.notes.some((note) => note.includes('command'))).toBe(true)
    expect(result.entries[0]?.draft.command).toBeUndefined()
    expect(result.entries[0]?.extras.command).toBeUndefined()
  })

  it('顶层结构问题抛带词典描述子的 ConfigError', () => {
    expect(() => parseMcpJsonText('')).toThrow(ConfigError)
    expect(() => parseMcpJsonText('[]')).toThrow(ConfigError)
    expect(() => parseMcpJsonText('{"mcpServers": {}}')).toThrow(ConfigError)
    expect(() => parseMcpJsonText('{}')).toThrow(ConfigError)

    let thrown: unknown
    try {
      parseMcpJsonText('not json')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ConfigError)
    const descriptor = (thrown as ConfigError).descriptor
    expect(descriptor && messageText(descriptor, makeT())).toContain('不是合法的 JSON')
  })
})

describe('extrasOf', () => {
  it('剔除已知键与 type，只留高级键', () => {
    expect(
      extrasOf({
        type: 'stdio',
        command: 'x',
        transport: 'stdio',
        reconnect: { retries: 1 },
        maxInstructionBytes: 5,
      }),
    ).toEqual({ reconnect: { retries: 1 }, maxInstructionBytes: 5 })
  })

  it('非对象 / 空 / 只含已知键时返回 undefined', () => {
    expect(extrasOf(undefined)).toBeUndefined()
    expect(extrasOf('x')).toBeUndefined()
    expect(extrasOf({})).toBeUndefined()
    expect(extrasOf({ command: 'x' })).toBeUndefined()
  })
})
