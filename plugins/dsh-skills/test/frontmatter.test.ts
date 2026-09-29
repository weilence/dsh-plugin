import { describe, expect, it } from 'vitest'
import {
  applyKnown,
  bodyForEditor,
  formatOfPath,
  parseKnown,
  renderFile,
  splitFrontmatter,
  yamlScalar,
  type FrontmatterDraft,
} from '../src/frontmatter'

const draft = (overrides: Partial<FrontmatterDraft> = {}): FrontmatterDraft => ({
  name: 'my-skill',
  description: '做某件事',
  modelInvocable: true,
  userInvocable: true,
  ...overrides,
})

describe('splitFrontmatter', () => {
  it('拆出标准围栏', () => {
    const split = splitFrontmatter('---\nname: a\ndescription: b\n---\n\n正文\n')
    expect(split).toEqual({ fm: 'name: a\ndescription: b\n', body: '\n正文\n' })
  })

  it('CRLF 围栏同样识别', () => {
    const split = splitFrontmatter('---\r\nname: a\r\n---\r\n\r\n正文\r\n')
    expect(split?.fm).toBe('name: a\r\n')
  })

  it('首行不是 --- 或缺闭合返回 undefined', () => {
    expect(splitFrontmatter('name: a\n---\n')).toBeUndefined()
    expect(splitFrontmatter('---\nname: a\n')).toBeUndefined()
    expect(splitFrontmatter('---')).toBeUndefined()
  })

  it('正文里的 --- 不影响闭合定位', () => {
    const split = splitFrontmatter('---\nname: a\n---\n\n---\n更深层的线\n')
    expect(split?.body).toBe('\n---\n更深层的线\n')
  })
})

describe('parseKnown', () => {
  it('读取五个已知键', () => {
    const known = parseKnown(
      "name: a\ndescription: '描述: 带冒号'\nwhenToUse: \"何时用\"\ndisable-model-invocation: true\nuser-invocable: 'no'",
    )
    expect(known).toEqual({
      name: 'a',
      description: '描述: 带冒号',
      whenToUse: '何时用',
      disableModelInvocation: true,
      userInvocable: false,
    })
  })

  it('嵌套在未知键下的同名子键不会被误读', () => {
    const known = parseKnown('metadata:\n  name: nested\n  user-invocable: false\nname: top\n')
    expect(known.name).toBe('top')
    expect(known.userInvocable).toBeUndefined()
  })

  it('字面块标量与折叠块标量', () => {
    const known = parseKnown('description: |\n  第一行\n  第二行\nwhenToUse: >\n  折叠一\n  折叠两\n')
    expect(known.description).toBe('第一行\n第二行\n')
    expect(known.whenToUse).toBe('折叠一 折叠两\n')
  })

  it('宽松布尔词与行尾注释', () => {
    const known = parseKnown('disable-model-invocation: Yes # 注释\nuser-invocable: off\n')
    expect(known.disableModelInvocation).toBe(true)
    expect(known.userInvocable).toBe(false)
  })

  it('空值与未知键被忽略', () => {
    const known = parseKnown('name:\ndescription:\nlicense: MIT\n')
    expect(known.name).toBeUndefined()
    expect(known.description).toBeUndefined()
  })
})

describe('applyKnown', () => {
  it('全新创建生成最小 frontmatter', () => {
    const fm = applyKnown('', draft())
    expect(fm).toBe('name: my-skill\ndescription: 做某件事')
  })

  it('关闭开关时落盘对应键，开启时移除', () => {
    const off = applyKnown('', draft({ modelInvocable: false, userInvocable: false }))
    expect(off).toContain('disable-model-invocation: false')
    expect(off).toContain('user-invocable: false')
    const on = applyKnown(
      'disable-model-invocation: false\nuser-invocable: false\nname: old\ndescription: 旧',
      draft(),
    )
    expect(on).not.toContain('disable-model-invocation')
    expect(on).not.toContain('user-invocable')
  })

  it('原位替换已知键并保留未知键与注释', () => {
    const fm = applyKnown(
      '# 顶部注释\nname: old-name\ndescription: 旧描述\nlicense: MIT\nmetadata:\n  kind: flow\nwhenToUse: 旧时机\n',
      draft({ whenToUse: '新时机' }),
    )
    const lines = fm.split('\n')
    expect(lines[0]).toBe('# 顶部注释')
    expect(fm).toContain('name: my-skill')
    expect(fm).toContain('description: 做某件事')
    expect(fm).toContain('whenToUse: 新时机')
    expect(fm).toContain('license: MIT')
    expect(fm).toContain('metadata:')
    expect(fm).toContain('  kind: flow')
  })

  it('whenToUse 缺失即删除该键（含块标量续行）', () => {
    const fm = applyKnown('name: a\ndescription: b\nwhenToUse: |\n  多行\n  时机\n', draft())
    expect(fm).not.toContain('whenToUse')
    expect(fm).not.toContain('多行')
  })

  it('块标量值被替换为单行新值', () => {
    const fm = applyKnown('description: |\n  很长的\n  多行描述\nname: a\n', draft())
    expect(fm).toContain('description: 做某件事')
    expect(fm).not.toContain('很长的')
    expect(fm.split('\n').filter((line) => line === '')).toHaveLength(0)
  })

  it('中间键被删除后不残留空行，追加的缺失键紧贴前文', () => {
    const fm = applyKnown(
      'name: a\ndescription: b\nwhenToUse: 旧时机\nuser-invocable: false\n',
      draft({ modelInvocable: false }),
    )
    expect(fm).toBe('name: my-skill\ndescription: 做某件事\ndisable-model-invocation: false')
  })

  it('需要引号的值被安全序列化', () => {
    const fm = applyKnown('', draft({ description: '含: 冒号 与 "引号" 和 #hash' }))
    expect(fm).toContain(`description: ${JSON.stringify('含: 冒号 与 "引号" 和 #hash')}`)
  })

  it('往返：applyKnown 的产物可被 parseKnown 读回', () => {
    const d = draft({ whenToUse: '时机：包含冒号', description: '描述 "quoted" #注释符' })
    const known = parseKnown(applyKnown('extra: keep\n', d))
    expect(known.name).toBe(d.name)
    expect(known.description).toBe(d.description)
    expect(known.whenToUse).toBe(d.whenToUse)
    expect(known.disableModelInvocation).toBeUndefined()
    expect(known.userInvocable).toBeUndefined()
  })
})

describe('renderFile / bodyForEditor', () => {
  it('围栏 + 空行 + 正文，末尾补换行', () => {
    expect(renderFile('name: a', '正文')).toBe('---\nname: a\n---\n\n正文\n')
    expect(renderFile('name: a', '正文\n')).toBe('---\nname: a\n---\n\n正文\n')
    expect(renderFile('name: a', '')).toBe('---\nname: a\n---\n')
  })

  it('bodyForEditor 去掉首个空行且可往返', () => {
    const file = renderFile('name: a', '正文')
    const split = splitFrontmatter(file)
    expect(split).toBeDefined()
    const round = renderFile(split!.fm, bodyForEditor(split!.body))
    expect(round).toBe(file)
  })
})

describe('yamlScalar', () => {
  it('安全值不加引号直写', () => {
    expect(yamlScalar('plain-value_1')).toBe('plain-value_1')
    expect(yamlScalar('中文描述')).toBe('中文描述')
  })

  it('危险值引写', () => {
    expect(yamlScalar('a: b')).toBe('"a: b"')
    expect(yamlScalar('#hash')).toBe('"#hash"')
    expect(yamlScalar('true')).toBe('"true"')
    expect(yamlScalar('42')).toBe('"42"')
    expect(yamlScalar('带 "引号"')).toBe('"带 \\"引号\\""')
    expect(yamlScalar(' 多余空白 ')).toBe('" 多余空白 "')
  })
})

describe('formatOfPath', () => {
  it('按文件名判定形态', () => {
    expect(formatOfPath('/root/my-skill.md')).toBe('flat')
    expect(formatOfPath('C:\\root\\my-skill\\SKILL.md')).toBe('bundle')
  })
})
