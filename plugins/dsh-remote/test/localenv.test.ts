// 内容指纹：技能（本机目录扫描与远端 find|sha256 行共用同一折叠函数；隐藏段
// 跳过、目录包与单文件并集）与插件包树（本机 walk 与远端 node -e 管线镜像；
// 排除段与打包单一来源）——两侧收集规则镜像，同内容必同指纹。

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  foldSkillDigest,
  packageTreeDigest,
  payloadFileName,
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

describe('packageTreeDigest', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-remote-pkg-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('排除 node_modules / .git、点文件计入、._ 前缀不计、内容或文件集变化即变', async () => {
    const digest = (content: string): string => createHash('sha256').update(content).digest('hex')
    await mkdir(join(home, 'node_modules', 'dep'), { recursive: true })
    await mkdir(join(home, '.git'), { recursive: true })
    await mkdir(join(home, 'lib'), { recursive: true })
    await writeFile(join(home, 'package.json'), '{}', 'utf8')
    await writeFile(join(home, '.npmignore'), 'x', 'utf8')
    await writeFile(join(home, '._package.json'), 'apple-double junk', 'utf8')
    await writeFile(join(home, 'lib', 'index.js'), 'export {}', 'utf8')
    await writeFile(join(home, 'node_modules', 'dep', 'junk.js'), 'junk', 'utf8')
    await writeFile(join(home, '.git', 'HEAD'), 'ref', 'utf8')

    const base = await packageTreeDigest(home)
    expect(base).toBe(
      foldSkillDigest([
        { path: '.npmignore', hash: digest('x') },
        { path: 'lib/index.js', hash: digest('export {}') },
        { path: 'package.json', hash: digest('{}') },
      ]),
    )
    // ._ 幽灵文件增删不影响指纹（macOS tar 的 xattr 序列化副产物，双端同样忽略）
    await rm(join(home, '._package.json'))
    expect(await packageTreeDigest(home)).toBe(base)

    // 内容变化 → 指纹变化
    await writeFile(join(home, 'lib', 'index.js'), 'export { v2 }', 'utf8')
    expect(await packageTreeDigest(home)).not.toBe(base)
  })

  it('包根不存在回 null（同步侧按无法比对保守处理）', async () => {
    expect(await packageTreeDigest(join(home, 'missing'))).toBeNull()
  })
})

describe('payloadFileName', () => {
  it('scope 折平 + 版本 + 指纹前 8 位（内容寻址：内容变则文件名变）', () => {
    expect(payloadFileName('@weilence/dsh-notify', '0.3.1', 'a'.repeat(64))).toBe(
      'weilence-dsh-notify-0.3.1-aaaaaaaa.tgz',
    )
    expect(payloadFileName('dsh-notify', '0.3.1', 'b'.repeat(64))).not.toBe(
      payloadFileName('dsh-notify', '0.3.1', 'a'.repeat(64)),
    )
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
