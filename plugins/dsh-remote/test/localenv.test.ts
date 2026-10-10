// 内容指纹：技能（本机目录扫描与远端 find|sha256 行共用同一折叠函数；隐藏段
// 跳过、目录包与单文件并集）——两侧收集规则镜像，同内容必同指纹。

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  foldSkillDigest,
  mcpSummary,
  parseMcpServers,
  readLocalMcp,
  scanSkillRows,
  type SkillsRoot,
} from '../src/localenv'

describe('foldSkillDigest', () => {
  it('输入顺序无关：折叠前按路径排序', () => {
    const left = foldSkillDigest([
      { path: 'x/SKILL.md', hash: 'h1' },
      { path: 'a.md', hash: 'h2' },
    ])
    const right = foldSkillDigest([
      { path: 'a.md', hash: 'h2' },
      { path: 'x/SKILL.md', hash: 'h1' },
    ])
    expect(left).toBe(right)
  })

  it('文件内容或文件集变化 → 指纹变化', () => {
    const base = foldSkillDigest([{ path: 'x/SKILL.md', hash: 'h1' }])
    expect(foldSkillDigest([{ path: 'x/SKILL.md', hash: 'h2' }])).not.toBe(base)
    expect(
      foldSkillDigest([
        { path: 'x/SKILL.md', hash: 'h1' },
        { path: 'x/extra.md', hash: 'h3' },
      ]),
    ).not.toBe(base)
  })
})

describe('scanSkillRows', () => {
  let home: string
  let root: SkillsRoot

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-remote-skills-'))
    root = { key: 'user-dsh', path: join(home, 'skills') }
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('目录包与单文件：digest 与手工折叠一致、隐藏文件不计入、description 提取', async () => {
    const dirSkill = '---\ndescription: 目录技能\n---\n正文'
    const fileSkill = '单文件技能'
    await mkdir(join(root.path, 'dir-skill'), { recursive: true })
    await writeFile(join(root.path, 'dir-skill', 'SKILL.md'), dirSkill, 'utf8')
    await writeFile(join(root.path, 'dir-skill', '.DS_Store'), 'junk', 'utf8')
    await writeFile(join(root.path, 'file-skill.md'), fileSkill, 'utf8')

    const rows = await scanSkillRows(root)
    expect(rows.map((row) => row.name)).toEqual(['dir-skill', 'file-skill'])
    expect(rows.find((row) => row.name === 'dir-skill')?.description).toBe('目录技能')

    const digest = (content: string): string => createHash('sha256').update(content).digest('hex')
    // .DS_Store 是隐藏段：不进指纹（远端 find ! -path '*/.*' 同规则）
    expect(rows.find((row) => row.name === 'dir-skill')?.digest).toBe(
      foldSkillDigest([{ path: 'dir-skill/SKILL.md', hash: digest(dirSkill) }]),
    )
    expect(rows.find((row) => row.name === 'file-skill')?.digest).toBe(
      foldSkillDigest([{ path: 'file-skill.md', hash: digest(fileSkill) }]),
    )
  })
})

describe('parseMcpServers / mcpSummary', () => {
  it('mcpServers 包装为主，缺包装时接受直接映射；非对象值跳过', () => {
    const wrapped = parseMcpServers(JSON.stringify({ $schema: 's', mcpServers: { a: { command: 'x' } } }))
    expect(wrapped.rootExtras).toEqual({ $schema: 's' })
    expect([...wrapped.entries.keys()]).toEqual(['a'])

    const bare = parseMcpServers(JSON.stringify({ b: { url: 'http://x' } }))
    expect([...bare.entries.keys()]).toEqual(['b'])

    const broken = parseMcpServers(JSON.stringify({ mcpServers: { bad: 'not-an-object' } }))
    expect(broken.entries.size).toBe(0)
  })

  it('非法 JSON 与顶层非对象抛错；空白文本为空状态', () => {
    expect(() => parseMcpServers('{ nope')).toThrow()
    expect(() => parseMcpServers('[1]')).toThrow()
    expect(parseMcpServers(null).entries.size).toBe(0)
  })

  it('mcpSummary：stdio 拼命令行、http 取 url、推断不出给占位', () => {
    expect(mcpSummary({ command: 'npx', args: ['-y', 'pkg'] })).toBe('npx -y pkg')
    expect(mcpSummary({ type: 'http', url: 'https://mcp.example/mcp' })).toBe('https://mcp.example/mcp')
    expect(mcpSummary({})).toBe('未声明传输')
  })
})

describe('readLocalMcp', () => {
  it('读全局档：原始条目身份保留，rows 带签名且按名排序；文件缺失为空', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-remote-mcp-'))
    try {
      await writeFile(
        join(home, 'mcp.json'),
        JSON.stringify({ mcpServers: { web: { url: 'https://mcp.example/mcp' }, cli: { command: 'npx' } } }),
        'utf8',
      )
      const local = await readLocalMcp(home)
      expect(local.file).toBe(join(home, 'mcp.json'))
      expect([...local.entries.keys()]).toEqual(['web', 'cli'])
      expect(local.rows.map((row) => row.name)).toEqual(['cli', 'web'])
      expect(local.rows[0]).toMatchObject({ name: 'cli', summary: 'npx' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
