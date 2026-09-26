/** patchFile：注释保留编辑、组合扫描与各写操作的文档往返。 */

import { describe, expect, it } from 'vitest'
import { MCP_PLUGIN_NAME } from '../src/shared'
import {
  appendMcpInsert,
  emptyPatchDoc,
  parsePatchDoc,
  removeInsertRow,
  removeOverridesOf,
  renderPatchDoc,
  scanPatchDoc,
  setEnabledInDoc,
  setInsertConfig,
  setOverrideConfig,
} from '../src/patchFile'

const SAMPLE = `# 顶部注释：本层由用户维护
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: demo
        url: https://mcp.example.com/mcp
        reconnect:
          enabled: true
# 行间注释也应保留
- id: mcp-demo
  disabled: true
- insert:
    - id: other-plugin
      name: someone-else
`

/** 仅 insert 声明（无裸覆盖行）的样例。 */
const STDIO_ONLY = `- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: demo
        command: npx
`

function roundTrip(text: string): string {
  return renderPatchDoc(parsePatchDoc(text))
}

describe('parse / render 往返', () => {
  it('保留注释与未触碰的行', () => {
    expect(roundTrip(SAMPLE)).toBe(SAMPLE)
  })

  it('拒绝非顶层数组的文档', () => {
    expect(() => parsePatchDoc('id: x\n')).toThrow('顶层数组')
    expect(() => parsePatchDoc('- [broken\n')).toThrow()
  })

  it('空文档作为缺失文件的基座', () => {
    const doc = emptyPatchDoc()
    expect(scanPatchDoc(doc)).toEqual({ inserts: [], overrides: [] })
    expect(renderPatchDoc(doc)).toBe('[]\n')
  })
})

describe('scanPatchDoc', () => {
  it('分类 insert 行与裸覆盖行，读取 id/name/config/disabled', () => {
    const scanned = scanPatchDoc(parsePatchDoc(SAMPLE))
    expect(scanned.inserts).toHaveLength(2)
    expect(scanned.inserts[0]).toMatchObject({
      patchIndex: 1,
      rowIndex: 0,
      id: 'mcp-demo',
      name: MCP_PLUGIN_NAME,
      disabled: undefined,
    })
    expect(scanned.inserts[0]?.config).toEqual({
      transport: 'streamable-http',
      serverName: 'demo',
      url: 'https://mcp.example.com/mcp',
      reconnect: { enabled: true },
    })
    expect(scanned.inserts[1]).toMatchObject({ id: 'other-plugin', name: 'someone-else' })
    // 裸行按 id 全量收集（ui-chat 也是裸行），命中哪些 mcp 行由调用方过滤。
    expect(scanned.overrides).toEqual([
      {
        patchIndex: 0,
        id: 'ui-chat',
        name: '@deepseek-ai/dsh-client-ui-chat',
        config: { transcriptView: 'standard' },
        disabled: undefined,
      },
      { patchIndex: 2, id: 'mcp-demo', name: undefined, config: undefined, disabled: true },
    ])
  })
})

describe('appendMcpInsert', () => {
  it('追加规范 insert 行并往返（仅注释的文件视作空文档）', () => {
    const doc = parsePatchDoc('# header\n')
    appendMcpInsert(doc, {
      id: 'mcp-new',
      config: { transport: 'stdio', serverName: 'new', command: 'npx', args: ['-y', 'x'] },
    })
    const scanned = scanPatchDoc(parsePatchDoc(renderPatchDoc(doc)))
    const added = scanned.inserts.find((row) => row.id === 'mcp-new')
    expect(added).toBeDefined()
    expect(added?.name).toBe(MCP_PLUGIN_NAME)
    expect(added?.config).toEqual({
      transport: 'stdio',
      serverName: 'new',
      command: 'npx',
      args: ['-y', 'x'],
    })
    expect(renderPatchDoc(doc)).toContain('# header')
  })
})

describe('setInsertConfig / setOverrideConfig', () => {
  it('整体替换 config 并保留其余键与注释', () => {
    const doc = parsePatchDoc(SAMPLE)
    setInsertConfig(
      doc,
      { patchIndex: 1, rowIndex: 0 },
      { transport: 'stdio', serverName: 'demo', command: 'node' },
    )
    const scanned = scanPatchDoc(parsePatchDoc(renderPatchDoc(doc)))
    expect(scanned.inserts[0]?.config).toEqual({ transport: 'stdio', serverName: 'demo', command: 'node' })
    expect(renderPatchDoc(doc)).toContain('# 行间注释也应保留')
  })

  it('替换裸行 config', () => {
    const doc = parsePatchDoc(SAMPLE)
    setOverrideConfig(doc, 2, { transport: 'stdio', serverName: 'demo', command: 'node' })
    const scanned = scanPatchDoc(parsePatchDoc(renderPatchDoc(doc)))
    const overridden = scanned.overrides.find((row) => row.id === 'mcp-demo')
    expect(overridden?.config).toEqual({ transport: 'stdio', serverName: 'demo', command: 'node' })
    expect(overridden?.disabled).toBe(true)
  })
})

describe('setEnabledInDoc', () => {
  it('已有裸行时改其 disabled（无变化时幂等返回 false）', () => {
    const doc = parsePatchDoc(SAMPLE)
    // SAMPLE 里 mcp-demo 已是 disabled: true：再停用是无变化。
    expect(setEnabledInDoc(doc, 'mcp-demo', false)).toBe(false)
    // 启用：disabled 翻成 false。
    expect(setEnabledInDoc(doc, 'mcp-demo', true)).toBe(true)
    const overridden = scanPatchDoc(doc).overrides.find((row) => row.id === 'mcp-demo')
    expect(overridden?.disabled).toBe(false)
  })

  it('无裸行时追加官方形态 {id, disabled}', () => {
    const doc = parsePatchDoc(STDIO_ONLY)
    expect(setEnabledInDoc(doc, 'mcp-demo', false)).toBe(true)
    const text = renderPatchDoc(doc)
    expect(text).toContain('- id: mcp-demo\n  disabled: true\n')
    // 幂等：目标值已是当前值时不再变化。
    const again = parsePatchDoc(text)
    expect(setEnabledInDoc(again, 'mcp-demo', false)).toBe(false)
    expect(renderPatchDoc(again)).toBe(text)
  })
})

describe('removeInsertRow / removeOverridesOf', () => {
  it('删除 insert 行并在宿主项只剩空 insert 时连同移除', () => {
    const doc = parsePatchDoc(SAMPLE)
    removeInsertRow(doc, { patchIndex: 1, rowIndex: 0 })
    const text = renderPatchDoc(doc)
    expect(text).not.toContain(`name: '@deepseek-ai/dsh-mcp-client'`)
    expect(text).toContain('other-plugin')
    expect(text).toContain('- id: mcp-demo\n  disabled: true')
  })

  it('删除整体针对 id 的裸覆盖行', () => {
    const doc = parsePatchDoc(SAMPLE)
    removeOverridesOf(doc, 'mcp-demo')
    const text = renderPatchDoc(doc)
    expect(text).not.toContain('disabled: true')
    expect(text).toContain('ui-chat')
    expect(text).toContain('mcp-demo')
  })
})
