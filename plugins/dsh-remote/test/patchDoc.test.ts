/** patchDoc：注释保留的 upsert / remove 往返。 */

import { describe, expect, it } from 'vitest'
import {
  emptyPatchDoc,
  parsePatchDoc,
  removeInsertRows,
  renderPatchDoc,
  scanInserts,
  upsertInsertRow,
} from '../src/patchDoc'

const REMOTE_PATCH = `- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: demo
        command: npx
# 用户手写注释，往返必须原样保留（归属其后的 other-plugin 行）
- id: other-plugin
  config: { a: 1 }
`

describe('scanInserts', () => {
  it('扫出 insert 行并跳过裸行', () => {
    const inserts = scanInserts(parsePatchDoc(REMOTE_PATCH))
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      id: 'mcp-demo',
      name: '@deepseek-ai/dsh-mcp-client',
      patchIndex: 0,
      rowIndex: 0,
    })
  })
})

describe('upsertInsertRow', () => {
  it('同 id 同名：整块替换 config；注释保留', () => {
    const doc = parsePatchDoc(REMOTE_PATCH)
    upsertInsertRow(doc, {
      id: 'mcp-demo',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { transport: 'streamable-http', serverName: 'demo', url: 'https://x' },
    })
    const text = renderPatchDoc(doc)
    expect(text).toContain('# 用户手写注释，往返必须原样保留')
    expect(text).toContain('streamable-http')
    expect(text).toContain('url: https://x')
    expect(text).not.toContain('command: npx')
    expect(scanInserts(parsePatchDoc(text))).toHaveLength(1)
  })

  it('同 id 不同名：不动别人的行，另起新行', () => {
    const doc = parsePatchDoc(REMOTE_PATCH)
    upsertInsertRow(doc, { id: 'other-plugin', name: 'dsh-mcp', config: { x: 1 } })
    const inserts = scanInserts(doc)
    expect(inserts.map((row) => row.id).sort()).toEqual(['mcp-demo', 'other-plugin'])
  })

  it('新 id：追加规范形态（含 disabled）', () => {
    const doc = emptyPatchDoc()
    upsertInsertRow(doc, {
      id: 'mcp-new',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'new' },
      disabled: true,
    })
    const text = renderPatchDoc(doc)
    expect(text).toContain('@deepseek-ai/dsh-mcp-client')
    expect(text).toContain('id: mcp-new')
    expect(text).toContain('disabled: true')
  })

  it('空文件（远端缺失）从空序列起步', () => {
    const doc = emptyPatchDoc()
    upsertInsertRow(doc, { id: 'a', name: 'b', config: {} })
    expect(scanInserts(doc)).toHaveLength(1)
  })
})

describe('removeInsertRows', () => {
  it('按 id 集合移除并保留无关行', () => {
    const doc = parsePatchDoc(REMOTE_PATCH)
    expect(removeInsertRows(doc, new Set(['mcp-demo']))).toBe(1)
    const text = renderPatchDoc(doc)
    expect(text).toContain('# 用户手写注释')
    expect(text).toContain('other-plugin')
    expect(text).not.toContain('mcp-demo')
  })

  it('移除后只剩空 insert 项时连同该项一起移除', () => {
    const doc = parsePatchDoc(REMOTE_PATCH)
    removeInsertRows(doc, new Set(['mcp-demo']))
    // 剩下的 other-plugin 是裸行，insert 项已空 → 整项移除，不残留 `- insert: []`
    expect(renderPatchDoc(doc)).not.toContain('insert')
  })
})
