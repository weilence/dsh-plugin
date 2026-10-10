/** .mcp.json 文件方言：解析 / 映射 / 序列化 / revision 的纯函数单测。 */

import { describe, expect, it } from 'vitest'
import { entryFromDraft, parseMcpFile, revisionOf, serializeMcpFile } from '../src/mcpFile'
import type { McpConfigDraft } from '../src/shared'

const draft = (partial: Partial<McpConfigDraft>): McpConfigDraft => ({
  transport: 'stdio',
  serverName: 'demo',
  command: 'npx',
  ...partial,
})

describe('parseMcpFile', () => {
  it('mcpServers 包装：合法条目映射为 Config 形态，disabled 进 valid', () => {
    const state = parseMcpFile(
      JSON.stringify({
        mcpServers: {
          demo: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], disabled: true },
          web: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } },
        },
      }),
    )
    expect([...state.valid.keys()]).toEqual(['demo', 'web'])
    expect(state.valid.get('demo')).toMatchObject({
      disabled: true,
      config: { transport: 'stdio', serverName: 'demo', command: 'npx', args: ['-y', 'pkg'] },
    })
    expect(state.valid.get('web')?.config).toMatchObject({
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    })
    expect(state.invalid.size).toBe(0)
  })

  it('缺 mcpServers 包装时接受「名称 → 配置」直接映射；sse 按 http 接入', () => {
    const state = parseMcpFile(
      JSON.stringify({ demo: { command: 'npx' }, legacy: { type: 'sse', url: 'http://x.example/sse' } }),
    )
    expect(state.valid.get('demo')?.config.transport).toBe('stdio')
    expect(state.valid.get('legacy')?.config.transport).toBe('streamable-http')
  })

  it('顶层除 mcpServers 外的键进 rootExtras（写回时身份保留）', () => {
    const state = parseMcpFile(JSON.stringify({ $schema: 'https://example.com/x.json', mcpServers: {} }))
    expect(state.rootExtras).toEqual({ $schema: 'https://example.com/x.json' })
  })

  it('坏条目进 invalid 不影响其余：名称非法、缺 command、类型不对、未知键保留', () => {
    const state = parseMcpFile(
      JSON.stringify({
        mcpServers: {
          'bad name': { command: 'npx' },
          nocmd: { type: 'stdio' },
          broken: 'x',
          advanced: { command: 'npx', reconnect: { enabled: false }, toolCallTimeoutMs: 5000 },
        },
      }),
    )
    expect(state.invalid.get('bad name')).toContain('名称需匹配')
    expect(state.invalid.get('nocmd')).toContain('command')
    expect(state.invalid.get('broken')).toContain('不是服务器配置对象')
    expect(state.valid.get('advanced')?.config).toMatchObject({
      reconnect: { enabled: false },
      toolCallTimeoutMs: 5000,
    })
  })

  it('顶层结构问题抛错：非法 JSON、非对象、服务器值不是对象之外的结构垃圾', () => {
    expect(() => parseMcpFile('{ nope')).toThrow(/不是合法的 JSON/)
    expect(() => parseMcpFile('[1,2]')).toThrow(/顶层必须是 JSON 对象/)
  })

  it('null 与空白文本是空状态', () => {
    for (const text of [null, '', '   ']) {
      const state = parseMcpFile(text)
      expect(state.entries.size).toBe(0)
      expect(state.valid.size).toBe(0)
    }
  })
})

describe('entryFromDraft / serializeMcpFile', () => {
  it('草稿 → 标准条目：stdio 不落 type，缺省键省略，disabled 仅停用落键', () => {
    expect(entryFromDraft(draft({ command: 'npx', args: [], env: {} }), undefined, false)).toEqual({
      command: 'npx',
    })
    expect(
      entryFromDraft(
        draft({ transport: 'streamable-http', command: undefined, url: 'http://x/mcp' }),
        undefined,
        true,
      ),
    ).toEqual({
      type: 'http',
      url: 'http://x/mcp',
      disabled: true,
    })
  })

  it('extra 过滤标准键后并入；往返 parse → serialize → parse 键集不变', () => {
    const state = parseMcpFile(
      JSON.stringify({ $schema: 's', mcpServers: { demo: { command: 'npx', custom: 1, disabled: true } } }),
    )
    const text = serializeMcpFile(state)
    const again = parseMcpFile(text)
    expect(again.rootExtras).toEqual({ $schema: 's' })
    expect(again.entries.get('demo')).toEqual({ command: 'npx', custom: 1, disabled: true })
    expect(text.endsWith('\n')).toBe(true)
  })

  it('写回新条目追加在键序末尾', () => {
    const state = parseMcpFile(JSON.stringify({ mcpServers: { a: { command: 'x' } } }))
    state.entries.set('b', entryFromDraft(draft({ serverName: 'b', command: 'y' }), undefined, false))
    const parsed = JSON.parse(serializeMcpFile(state)) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(parsed.mcpServers)).toEqual(['a', 'b'])
  })
})

describe('revisionOf', () => {
  it('内容哈希：同文同值，异文异值，null 文件为 null', () => {
    expect(revisionOf('abc')).toBe(revisionOf('abc'))
    expect(revisionOf('abc')).not.toBe(revisionOf('abd'))
    expect(revisionOf(null)).toBeNull()
  })
})
