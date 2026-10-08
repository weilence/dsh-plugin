import { describe, expect, it } from 'vitest'
import { emptyPatchDoc, parsePatchDoc, renderPatchDoc, scanPatchDoc } from '../src/patch'

describe('parsePatchDoc', () => {
  it('解析顶层数组并保留注释', () => {
    const document = parsePatchDoc('# 头注释\n- id: web\n  config: { searchProvider: zhipu }\n')
    expect(renderPatchDoc(document)).toContain('# 头注释')
    expect(scanPatchDoc(document).overrides).toHaveLength(1)
  })

  it('空文件与仅注释文件对齐官方 fail loud：抛异常；空文档基座视作空序列', () => {
    expect(() => parsePatchDoc('')).toThrow('顶层数组')
    expect(() => parsePatchDoc('# 只是注释\n')).toThrow('顶层数组')
    expect(scanPatchDoc(emptyPatchDoc())).toEqual({ inserts: [], overrides: [] })
  })

  it('空基座不带 flow 标记：追加行渲染为 block 风格', () => {
    const document = emptyPatchDoc()
    document.add(document.createNode({ id: 'web', config: { searchProvider: 'zhipu' } }))
    document.add(document.createNode({ id: 'mcp', commentBefore: '# 标记' }))
    const text = renderPatchDoc(document)
    expect(text).toMatch(/^- id: web$/m)
    expect(text).toContain('  searchProvider: zhipu')
    expect(text).toContain('# 标记')
    expect(text).not.toContain('[')
    expect(text).not.toContain('{')
  })

  it('flow 存量文件经编辑后写盘转为 block 风格；无数据落空数组', () => {
    const document = parsePatchDoc('[ { id: web, config: { searchProvider: zhipu } } ]\n')
    document.add(document.createNode({ id: 'mcp' }))
    const text = renderPatchDoc(document)
    expect(text).toMatch(/^- id: web$/m)
    expect(text).toContain('  searchProvider: zhipu')
    expect(text).not.toContain('{')
    expect(text).not.toContain('[')
    expect(renderPatchDoc(parsePatchDoc('[]'))).toBe('[]\n')
  })

  it('非数组顶层与语法错误抛异常', () => {
    expect(() => parsePatchDoc('id: web\n')).toThrow('顶层数组')
    expect(() => parsePatchDoc('- id: [unclosed\n')).toThrow()
  })

  it('序列化保证结尾换行', () => {
    expect(renderPatchDoc(parsePatchDoc('[]'))).toBe('[]\n')
  })
})

describe('scanPatchDoc', () => {
  it('区分 insert 行与覆盖行，fold 序保持文件顺序', () => {
    const document = parsePatchDoc(`
- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: demo }
      disabled: true
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: zhipu
`)
    const { inserts, overrides } = scanPatchDoc(document)
    expect(inserts).toEqual([
      {
        patchIndex: 0,
        rowIndex: 0,
        id: 'mcp-demo',
        name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: 'demo' },
        disabled: true,
      },
    ])
    expect(overrides).toEqual([
      {
        patchIndex: 1,
        id: 'web',
        name: '@deepseek-ai/dsh-web',
        config: { searchProvider: 'zhipu' },
        disabled: undefined,
      },
    ])
  })

  it('跳过缺 id 或非字符串 id 的行', () => {
    const document = parsePatchDoc('- config: {}\n- id: 42\n- id: ok\n')
    expect(scanPatchDoc(document).overrides.map((row) => row.id)).toEqual(['ok'])
  })
})
