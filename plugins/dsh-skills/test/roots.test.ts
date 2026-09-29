import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RootMatcher, agentsSkillsDir, findProjectRoot, isUnder, managedRoots } from '../src/roots'
import { sourceLabel } from '../src/shared'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skills-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('isUnder', () => {
  it('严格子路径判定', () => {
    const root = process.platform === 'win32' ? 'C:\\skills' : '/skills'
    const sep = process.platform === 'win32' ? '\\' : '/'
    expect(isUnder(root + sep + 'a.md', root)).toBe(true)
    expect(isUnder(root + sep + 'a' + sep + 'SKILL.md', root)).toBe(true)
    expect(isUnder(root, root)).toBe(false)
    expect(isUnder(root + sep + '..' + sep + 'escape.md', root)).toBe(false)
  })
})

describe('findProjectRoot', () => {
  it('最近的 .git 祖先', async () => {
    const base = await tempDir()
    const nested = join(base, 'a', 'b')
    await mkdir(nested, { recursive: true })
    await mkdir(join(base, 'a', '.git'), { recursive: true })
    expect(await findProjectRoot(nested)).toBe(join(base, 'a'))
  })

  it('无 .git 回 cwd 自身', async () => {
    const base = await tempDir()
    expect(await findProjectRoot(base)).toBe(base)
  })
})

describe('managedRoots', () => {
  it('cwd 缺失只有用户级根', async () => {
    const roots = await managedRoots(undefined)
    expect(roots.map((root) => root.id)).toEqual(['user-dsh', 'user-agents'])
  })

  it('有 cwd 时项目根在前', async () => {
    const base = await tempDir()
    await mkdir(join(base, '.git'), { recursive: true })
    const roots = await managedRoots(base)
    expect(roots.map((root) => root.id)).toEqual(['project-dsh', 'project-agents', 'user-dsh', 'user-agents'])
    expect(roots[0]?.path).toBe(join(base, '.dsh', 'skills'))
    expect(roots[1]?.path).toBe(join(base, '.agents', 'skills'))
  })
})

describe('RootMatcher 归属判定', () => {
  it('命中的根（含 realpath 变体）', async () => {
    const base = await tempDir()
    const rootDir = join(base, 'skills')
    await mkdir(rootDir, { recursive: true })
    const roots = [{ id: 'user-dsh' as const, path: rootDir }]
    const matcher = await RootMatcher.create(roots)
    expect((await matcher.match(join(rootDir, 'a.md')))?.id).toBe('user-dsh')
    expect((await matcher.match(join(rootDir, 'a', 'SKILL.md')))?.id).toBe('user-dsh')
    expect(await matcher.match(join(base, 'outside.md'))).toBeUndefined()
  })
})

describe('环境变量解析', () => {
  it('DSH_AGENTS_HOME 覆盖默认 ~/.agents', () => {
    expect(agentsSkillsDir({ DSH_AGENTS_HOME: '/custom/agents' } as Record<string, string>)).toBe(
      process.platform === 'win32' ? 'D:\\custom\\agents\\skills' : '/custom/agents/skills',
    )
  })

  it('四个根都有展示标签', () => {
    expect(sourceLabel('user-dsh')).toContain('.dsh/skills')
    expect(sourceLabel('project-agents')).toContain('.agents/skills')
  })
})

describe('生成产物与官方解析器约定的一致性', () => {
  it('生成的文件能被 splitFrontmatter 拆回并读出已知键', async () => {
    const { renderFile, applyKnown, splitFrontmatter, parseKnown } = await import('../src/frontmatter')
    const file = renderFile(
      applyKnown('', { name: 'gen', description: '描述', modelInvocable: true, userInvocable: true }),
      '正文内容',
    )
    const split = splitFrontmatter(file)
    expect(split).toBeDefined()
    expect(parseKnown(split!.fm)).toEqual({ name: 'gen', description: '描述' })
  })
})
