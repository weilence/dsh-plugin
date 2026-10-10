/** patchDoc：层扫描用的 insert 行读取（写入侧已随 MCP 同步迁往 .mcp.json）。 */

import { describe, expect, it } from 'vitest'
import { parsePatchDoc, scanInserts } from '../src/patchDoc'

const LOCAL_PATCH = `- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: demo
        command: npx
# 用户手写注释，归属其后的 other-plugin 行
- id: other-plugin
  config: { a: 1 }
`

describe('scanInserts', () => {
  it('扫出 insert 行并跳过非 insert 行', () => {
    const inserts = scanInserts(parsePatchDoc(LOCAL_PATCH))
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      id: 'mcp-demo',
      name: '@deepseek-ai/dsh-mcp-client',
      patchIndex: 0,
      rowIndex: 0,
    })
  })
})
