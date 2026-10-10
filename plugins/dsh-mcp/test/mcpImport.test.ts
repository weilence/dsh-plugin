import { describe, expect, it } from 'vitest'
import { ConfigError, extrasOf, fromStandardJson, toStandardJson } from '../src/mcpConfig'
import { messageText } from '../src/client/locales'
import { makeT } from './i18n'

describe('fromStandardJson', () => {
  it('解析 mcpServers 包装的多个服务器并身份保留未知键', () => {
    const result = fromStandardJson(
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
    expect(result.rows).toHaveLength(2)
    const [first, second] = result.rows
    expect(first.serverName).toBe('context7')
    expect(first.draft).toEqual({
      transport: 'stdio',
      serverName: 'context7',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: { API_KEY: 'k' },
    })
    expect(first.extras).toEqual({ reconnect: { retries: 3 } })
    expect(messageText(first.notes[0]!, makeT())).toContain('reconnect')
    expect(second.serverName).toBe('remote')
    expect(second.draft.transport).toBe('streamable-http')
    expect(second.draft.url).toBe('https://mcp.example.com/mcp')
  })

  it('单个服务器对象：从 command / URL 自动推导名称，无需手填', () => {
    const byCommand = fromStandardJson(JSON.stringify({ command: 'uvx', args: ['mcp-server'] }))
    expect(byCommand.rows[0]?.serverName).toBe('uvx')
    expect(byCommand.rows[0]?.draft.transport).toBe('stdio')
    expect(messageText(byCommand.rows[0]!.notes[0]!, makeT())).toContain('已自动命名')

    const byUrl = fromStandardJson(JSON.stringify({ url: 'https://mcp.example.com/mcp' }))
    expect(byUrl.rows[0]?.serverName).toBe('mcp-example-com')
    expect(byUrl.rows[0]?.draft.transport).toBe('streamable-http')

    const byWindowsPath = fromStandardJson(JSON.stringify({ command: 'C:\\tools\\server.exe' }))
    expect(byWindowsPath.rows[0]?.serverName).toBe('server')
  })

  it('{"名称": {...}} 直接映射：键名即服务器名', () => {
    const result = fromStandardJson(
      JSON.stringify({
        context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      }),
    )
    expect(result.problems).toEqual([])
    expect(result.rows.map((row) => row.serverName)).toEqual(['context7', 'remote'])
    expect(result.rows[1]?.draft.transport).toBe('streamable-http')
  })

  it('直接映射里的非对象值进入 problems 而不是整体失败', () => {
    const result = fromStandardJson(JSON.stringify({ good: { command: 'x' }, bad: 1 }))
    expect(result.rows.map((row) => row.serverName)).toEqual(['good'])
    expect(result.problems[0]?.name).toBe('bad')
  })

  it('type 缺失时按 command / url 推断传输形态', () => {
    const result = fromStandardJson(
      JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { url: 'https://x/mcp' } } }),
    )
    expect(result.rows[0]?.draft.transport).toBe('stdio')
    expect(result.rows[1]?.draft.transport).toBe('streamable-http')
  })

  it('sse 归一为 streamable-http 并提示已弃用', () => {
    const result = fromStandardJson(
      JSON.stringify({ mcpServers: { a: { type: 'sse', url: 'https://x/sse' } } }),
    )
    expect(result.rows[0]?.draft.transport).toBe('streamable-http')
    expect(result.rows[0]?.notes.some((note) => messageText(note, makeT()).includes('已弃用'))).toBe(true)
  })

  it('disabled 语义转换为行级停用：不进 config，带备注', () => {
    const result = fromStandardJson(
      JSON.stringify({ mcpServers: { a: { type: 'stdio', command: 'x', disabled: true } } }),
    )
    const row = result.rows[0]!
    expect(row.disabled).toBe(true)
    expect(row.extras.disabled).toBeUndefined()
    expect(row.draft).not.toHaveProperty('disabled')
    expect(row.notes.some((note) => messageText(note, makeT()).includes('disabled'))).toBe(true)
  })

  it('disabled 缺省或 false 视为启用', () => {
    const absent = fromStandardJson(JSON.stringify({ a: { type: 'stdio', command: 'x' } }))
    expect(absent.rows[0]?.disabled).toBe(false)
    const off = fromStandardJson(JSON.stringify({ a: { type: 'stdio', command: 'x', disabled: false } }))
    expect(off.rows[0]?.disabled).toBe(false)
  })

  it('${PLUGIN_ROOT} 类占位符报为问题条目', () => {
    const result = fromStandardJson(
      JSON.stringify({
        mcpServers: { a: { type: 'stdio', command: './bin/x', args: ['${PLUGIN_ROOT}/c'] } },
      }),
    )
    expect(result.rows).toHaveLength(0)
    expect(messageText(result.problems[0]!.message, makeT())).toContain('占位符')
  })

  it('非法 serverName 键与缺少必填字段进入 problems', () => {
    const result = fromStandardJson(
      JSON.stringify({
        mcpServers: { 'bad name!': { command: 'x' }, b: { type: 'stdio' }, c: { type: 'http' } },
      }),
    )
    expect(result.rows).toHaveLength(0)
    expect(result.problems.map((problem) => messageText(problem.message, makeT()))).toEqual([
      '名称「bad name!」需匹配 ^[A-Za-z0-9_-]{1,32}$',
      'stdio 服务器缺少 command',
      'HTTP 服务器缺少 url',
    ])
  })

  it('跨传输形态的专属键被忽略并给出提示', () => {
    const result = fromStandardJson(
      JSON.stringify({ mcpServers: { a: { type: 'http', url: 'https://x/mcp', command: 'x' } } }),
    )
    expect(result.rows[0]?.notes.some((note) => messageText(note, makeT()).includes('command'))).toBe(true)
    expect(result.rows[0]?.draft.command).toBeUndefined()
    expect(result.rows[0]?.extras.command).toBeUndefined()
  })

  it('顶层结构问题抛带词典描述子的 ConfigError', () => {
    expect(() => fromStandardJson('')).toThrow(ConfigError)
    expect(() => fromStandardJson('[]')).toThrow(ConfigError)
    expect(() => fromStandardJson('{"mcpServers": {}}')).toThrow(ConfigError)
    expect(() => fromStandardJson('{}')).toThrow(ConfigError)

    let thrown: unknown
    try {
      fromStandardJson('not json')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ConfigError)
    const descriptor = (thrown as ConfigError).descriptor
    expect(descriptor && messageText(descriptor, makeT())).toContain('不是合法的 JSON')
  })
})

describe('toStandardJson', () => {
  it('与 fromStandardJson 的直接映射方言互逆：type 承载 transport，高级键往返无损', () => {
    const config = {
      transport: 'stdio',
      serverName: 'context7',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      reconnect: { retries: 3 },
    }
    const json = toStandardJson(config)
    expect(json).toEqual({
      context7: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        reconnect: { retries: 3 },
      },
    })

    const result = fromStandardJson(JSON.stringify(json))
    const row = result.rows[0]!
    expect(row.draft.transport).toBe('stdio')
    expect(row.draft.command).toBe('npx')
    expect(row.extras).toEqual({ reconnect: { retries: 3 } })
  })

  it('streamable-http 形态同样互逆', () => {
    const json = toStandardJson({
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    })
    const row = fromStandardJson(JSON.stringify(json)).rows[0]!
    expect(row.draft.transport).toBe('streamable-http')
    expect(row.draft.url).toBe('https://mcp.example.com/mcp')
  })

  it('行级 disabled 停用态往返无损；启用时省略该键', () => {
    const disabledJson = toStandardJson({ transport: 'stdio', serverName: 'a', command: 'x' }, true)
    expect(disabledJson).toEqual({ a: { type: 'stdio', disabled: true, command: 'x' } })
    expect(fromStandardJson(JSON.stringify(disabledJson)).rows[0]?.disabled).toBe(true)

    const enabledJson = toStandardJson({ transport: 'stdio', serverName: 'a', command: 'x' })
    expect(enabledJson).toEqual({ a: { type: 'stdio', command: 'x' } })
    expect(fromStandardJson(JSON.stringify(enabledJson)).rows[0]?.disabled).toBe(false)
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
