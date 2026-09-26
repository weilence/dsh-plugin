import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT_LABELS, agentsSkillsDir, findProjectRoot, isUnder, managedRoots, matchRoot } from '../src/roots'

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
  it('cwd 缺席只有用户级根', async () => {
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

describe('matchRoot', () => {
  it('归属命中的根', async () => {
    const base = await tempDir()
    const rootDir = join(base, 'skills')
    await mkdir(rootDir, { recursive: true })
    const roots = [{ id: 'user-dsh' as const, path: rootDir }]
    expect((await matchRoot(join(rootDir, 'a.md'), roots))?.id).toBe('user-dsh')
    expect((await matchRoot(join(rootDir, 'a', 'SKILL.md'), roots))?.id).toBe('user-dsh')
    expect(await matchRoot(join(base, 'outside.md'), roots)).toBeUndefined()
  })
})

describe('环境变量解析', () => {
  it('DSH_AGENTS_HOME 覆盖默认 ~/.agents', () => {
    expect(agentsSkillsDir({ DSH_AGENTS_HOME: '/custom/agents' } as Record<string, string>)).toBe(
      process.platform === 'win32' ? 'D:\\custom\\agents\\skills' : '/custom/agents/skills',
    )
  })

  it('四个根都有标签', () => {
    expect(ROOT_LABELS['user-dsh']).toContain('.dsh/skills')
    expect(ROOT_LABELS['project-agents']).toContain('.agents/skills')
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
