import { describe, expect, it } from 'vitest'
import { parsePatchDoc, renderPatchDoc } from '@dsh-plugins/shared/patch'
import { appendManagedRow, disableInRow, enableInRow, scanWebRows } from '../src/switchPatch'

const PROFILE_PATCH = `# 手写注释要保留
- insert:
    - id: other
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: demo }
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official
    fetchProvider: http
`

describe('scanWebRows', () => {
  it('只收 id 匹配且 name 缺失或一致的覆盖行', () => {
    const document = parsePatchDoc(`
- id: web
  name: '@other/plugin'
  config: { searchProvider: zhipu }
- id: web
  config: { searchProvider: deepseek-official }
- id: not-web
  config: {}
`)
    const rows = scanWebRows(document)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.config).toEqual({ searchProvider: 'deepseek-official' })
  })

  it('带出行注释供标记识别', () => {
    const document = parsePatchDoc('# dsh-zhipu-tools previous: exa\n- id: web\n')
    expect(scanWebRows(document)[0]?.comment).toContain('previous: exa')
  })
})

describe('enableInRow', () => {
  it('只改 searchProvider 一个键，保留其他键与手写注释，并记录原值', () => {
    const document = parsePatchDoc(PROFILE_PATCH)
    const row = scanWebRows(document)[0]!
    expect(enableInRow(document, row)).toBe(true)
    const text = renderPatchDoc(document)
    expect(text).toContain('# 手写注释要保留')
    expect(text).toContain('# dsh-zhipu-tools previous: deepseek-official')
    expect(scanWebRows(document)[0]?.config).toEqual({ searchProvider: 'zhipu', fetchProvider: 'http' })
    // 其他行原样保留。
    expect(text).toContain('serverName: demo')
  })

  it('config 缺失的行创建只含 searchProvider 的 config', () => {
    const document = parsePatchDoc('- id: web\n')
    expect(enableInRow(document, scanWebRows(document)[0]!)).toBe(true)
    expect(scanWebRows(document)[0]?.config).toEqual({ searchProvider: 'zhipu' })
    expect(renderPatchDoc(document)).toContain('previous: none')
  })

  it('已是智谱的行不再改写（不覆盖已有标记）', () => {
    const document = parsePatchDoc(
      '# dsh-zhipu-tools previous: exa\n- id: web\n  config: { searchProvider: zhipu }\n',
    )
    expect(enableInRow(document, scanWebRows(document)[0]!)).toBe(false)
    expect(renderPatchDoc(document)).toContain('previous: exa')
  })
})

describe('disableInRow', () => {
  it('带原值标记的行恢复原值并清除标记', () => {
    const document = parsePatchDoc(
      '# dsh-zhipu-tools previous: deepseek-official\n- id: web\n  config:\n    searchProvider: zhipu\n    fetchProvider: http\n',
    )
    expect(disableInRow(document, scanWebRows(document)[0]!)).toBe(true)
    expect(scanWebRows(document)[0]?.config).toEqual({
      searchProvider: 'deepseek-official',
      fetchProvider: 'http',
    })
    expect(renderPatchDoc(document)).not.toContain('dsh-zhipu-tools')
  })

  it('previous: none 时删除 searchProvider 键而非写默认值', () => {
    const document = parsePatchDoc(
      '# dsh-zhipu-tools previous: none\n- id: web\n  config:\n    searchProvider: zhipu\n    fetchProvider: http\n',
    )
    expect(disableInRow(document, scanWebRows(document)[0]!)).toBe(true)
    expect(scanWebRows(document)[0]?.config).toEqual({ fetchProvider: 'http' })
  })

  it('手写智谱行（无标记）改回官方默认', () => {
    const document = parsePatchDoc('- id: web\n  config: { searchProvider: zhipu }\n')
    expect(disableInRow(document, scanWebRows(document)[0]!)).toBe(true)
    expect(scanWebRows(document)[0]?.config).toEqual({ searchProvider: 'deepseek-official' })
  })

  it('本插件新建的行（managed）整行删除', () => {
    const document = parsePatchDoc(
      "# dsh-zhipu-tools managed（关闭时删除本行）\n- id: web\n  name: '@deepseek-ai/dsh-web'\n  config:\n    searchProvider: zhipu\n    fetchProvider: http\n",
    )
    expect(disableInRow(document, scanWebRows(document)[0]!)).toBe(true)
    expect(scanWebRows(document)).toHaveLength(0)
  })

  it('managed 行携带条目级以外的键时不删行，改回官方默认', () => {
    const document = parsePatchDoc(
      "# dsh-zhipu-tools managed\n- id: web\n  name: '@deepseek-ai/dsh-web'\n  note: 手写备注\n  config: { searchProvider: zhipu }\n",
    )
    expect(disableInRow(document, scanWebRows(document)[0]!)).toBe(true)
    expect(scanWebRows(document)).toHaveLength(1)
    expect(scanWebRows(document)[0]?.config).toEqual({ searchProvider: 'deepseek-official' })
    expect(renderPatchDoc(document)).toContain('手写备注')
  })

  it('当前值不是智谱时不做任何改动', () => {
    const document = parsePatchDoc('- id: web\n  config: { searchProvider: exa }\n')
    expect(disableInRow(document, scanWebRows(document)[0]!)).toBe(false)
    expect(scanWebRows(document)[0]?.config).toEqual({ searchProvider: 'exa' })
  })
})

describe('appendManagedRow', () => {
  it('以生效配置为底整体替换，带 managed 标记', () => {
    const document = parsePatchDoc('[]\n')
    appendManagedRow(document, { searchProvider: 'zhipu', fetchProvider: 'http', extra: 'kept' })
    const rows = scanWebRows(document)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.config).toEqual({ searchProvider: 'zhipu', fetchProvider: 'http', extra: 'kept' })
    expect(rows[0]?.comment).toContain('dsh-zhipu-tools managed')
    expect(rows[0]?.name).toBe('@deepseek-ai/dsh-web')
  })
})
