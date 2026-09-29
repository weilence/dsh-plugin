import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cloneToTemp, discoverRepoSkills, gitUrlProblem, installCandidates } from '../src/gitInstall'

const execFileAsync = promisify(execFile)

/** 在本地创建一个 git 仓库并提交全部内容（测试稀疏克隆用）。 */
async function gitInit(repo: string): Promise<void> {
  const git = (args: string[]): Promise<unknown> =>
    execFileAsync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  await git(['init', '-q'])
  await git(['add', '-A'])
  await git(['commit', '-qm', 'init'])
}

/** Windows 路径 → file:// URL（cloneToTemp 不做 URL 校验，测试可直接用）。 */
function fileUrlOf(path: string): string {
  return `file:///${path.replaceAll('\\', '/')}`
}

let work: string

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'dsh-skills-git-test-'))
})

afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n正文。\n`
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

describe('gitUrlProblem', () => {
  it('接受 https / ssh / scp 形式，拒绝本地路径与空白', () => {
    expect(gitUrlProblem('https://github.com/anthropics/skills')).toBeNull()
    expect(gitUrlProblem('http://gitee.local/team/repo.git')).toBeNull()
    expect(gitUrlProblem('ssh://git@github.com/owner/repo.git')).toBeNull()
    expect(gitUrlProblem('git@github.com:owner/repo.git')).toBeNull()
    expect(gitUrlProblem('')).toContain('不能为空')
    expect(gitUrlProblem('D:\\repo')).toContain('不支持本地路径')
    expect(gitUrlProblem('file:///tmp/repo')).toContain('不支持本地路径')
    expect(gitUrlProblem('/tmp/repo')).toContain('不支持本地路径')
    expect(gitUrlProblem('not-a-url')).toContain('无法识别')
    expect(gitUrlProblem('https:// a b')).not.toBeNull()
  })
})

describe('discoverRepoSkills：标准容器', () => {
  it('发现 skills / .agents/skills / .claude/skills 与分类嵌套', async () => {
    const repo = join(work, 'repo-a')
    await write(join(repo, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', '根容器技能'))
    await write(join(repo, 'skills', 'cat', 'beta', 'SKILL.md'), skillMd('beta', '分类布局技能'))
    await write(join(repo, '.agents', 'skills', 'gamma', 'SKILL.md'), skillMd('gamma', 'agents 容器技能'))
    await write(join(repo, '.claude', 'skills', 'delta', 'SKILL.md'), skillMd('delta', 'claude 容器技能'))
    const { skills, notes } = await discoverRepoSkills(repo)
    expect(notes).toEqual([])
    const byDir = new Map(skills.map((skill) => [skill.dir, skill]))
    expect(byDir.get('skills/alpha')?.origin).toBe('skills')
    expect(byDir.get('skills/cat/beta')?.description).toBe('分类布局技能')
    expect(byDir.get('.agents/skills/gamma')?.origin).toBe('agents')
    expect(byDir.get('.claude/skills/delta')?.origin).toBe('claude')
  })

  it('浅层 SKILL.md 遮蔽深层；缺 description 标记为不可安装；根单技能 origin=root', async () => {
    const repo = join(work, 'repo-shadow')
    await write(join(repo, 'skills', 'parent', 'SKILL.md'), skillMd('parent', '外层'))
    await write(join(repo, 'skills', 'parent', 'child', 'SKILL.md'), skillMd('child', '内层'))
    await write(join(repo, 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\n正文')
    await write(join(repo, 'SKILL.md'), skillMd('whole-repo', '仓库根单技能'))
    const { skills } = await discoverRepoSkills(repo)
    const dirs = skills.map((skill) => skill.dir)
    expect(dirs).toContain('skills/parent')
    expect(dirs).not.toContain('skills/parent/child')
    expect(dirs).toContain('.')
    expect(skills.find((skill) => skill.dir === 'skills/broken')?.problem).toContain('description')
    const rootSkill = skills.find((skill) => skill.dir === '.')
    expect(rootSkill?.origin).toBe('root')
    expect(rootSkill?.name).toBe('whole-repo')
  })
})

describe('discoverRepoSkills：marketplace / plugin.json 声明', () => {
  it('读取 pluginRoot、相对 source 与 skills 数组', async () => {
    const repo = join(work, 'repo-market')
    await write(
      join(repo, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        metadata: { pluginRoot: './plugins' },
        plugins: [{ name: 'p1', source: 'p1', skills: ['./skills/review'] }],
      }),
    )
    await write(
      join(repo, 'plugins', 'p1', 'skills', 'review', 'SKILL.md'),
      skillMd('review', '声明路径技能'),
    )
    await write(
      join(repo, 'plugins', 'p1', 'skills', 'extra', 'SKILL.md'),
      skillMd('extra', '插件 skills 容器技能'),
    )
    const { skills, notes } = await discoverRepoSkills(repo)
    expect(notes).toEqual([])
    const dirs = skills.map((skill) => skill.dir)
    expect(dirs).toContain('plugins/p1/skills/review')
    expect(dirs).toContain('plugins/p1/skills/extra')
    expect(skills.find((skill) => skill.dir === 'plugins/p1/skills/review')?.origin).toBe('marketplace')
  })

  it('远程 source 插件跳过并给出提示', async () => {
    const repo = join(work, 'repo-remote')
    await write(
      join(repo, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'ext', source: { github: 'owner/repo' } }] }),
    )
    const { skills, notes } = await discoverRepoSkills(repo)
    expect(skills).toEqual([])
    expect(notes[0]).toContain('ext')
  })

  it('单插件仓库的 plugin.json 也被识别', async () => {
    const repo = join(work, 'repo-plugin')
    await write(
      join(repo, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'solo', skills: ['./nested/tool'] }),
    )
    await write(join(repo, 'nested', 'tool', 'SKILL.md'), skillMd('tool', 'plugin.json 声明技能'))
    const { skills } = await discoverRepoSkills(repo)
    expect(skills.find((skill) => skill.dir === 'nested/tool')?.origin).toBe('plugin')
  })
})

describe('cloneToTemp：部分克隆 + 稀疏检出', () => {
  it('只检出技能相关目录，marketplace 声明的插件目录也会补齐', async () => {
    const repo = join(work, 'sparse-fixture')
    await write(join(repo, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', '标准位置技能'))
    await write(join(repo, 'docs', 'big.md'), '# 大文档，不应被检出')
    await write(
      join(repo, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        metadata: { pluginRoot: './plugins' },
        plugins: [{ name: 'p1', source: 'p1', skills: ['./skills/review'] }],
      }),
    )
    await write(
      join(repo, 'plugins', 'p1', 'skills', 'review', 'SKILL.md'),
      skillMd('review', '声明路径技能'),
    )
    await gitInit(repo)

    const dest = await cloneToTemp(fileUrlOf(repo))
    try {
      const exists = async (rel: string): Promise<boolean> => {
        try {
          await stat(join(dest, rel))
          return true
        } catch {
          return false
        }
      }
      expect(await exists('skills/alpha/SKILL.md')).toBe(true)
      expect(await exists('.claude-plugin/marketplace.json')).toBe(true)
      expect(await exists('plugins/p1/skills/review/SKILL.md')).toBe(true)
      expect(await exists('docs/big.md')).toBe(false)
      const { skills } = await discoverRepoSkills(dest)
      expect(skills.map((skill) => skill.name).sort()).toEqual(['alpha', 'review'])
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })
})

describe('installCandidates', () => {
  it('整目录复制进目标根；冲突拒绝；问题候选失败', async () => {
    const source = join(work, 'install-src')
    await write(join(source, 'skills', 'packable', 'SKILL.md'), skillMd('packable', '可安装'))
    await write(join(source, 'skills', 'packable', 'references', 'deep.md'), '# 参考')
    await write(join(source, 'skills', 'second', 'SKILL.md'), skillMd('second', '将冲突'))
    await write(join(source, 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\n')
    const target = join(work, 'install-target')
    await write(join(target, 'second', 'SKILL.md'), skillMd('second', '已存在'))

    const { skills } = await discoverRepoSkills(source)
    const outcome = await installCandidates({ id: 'user-agents', path: target }, skills, source)
    expect(outcome.installed.map((row) => row.name)).toEqual(['packable'])
    expect(outcome.conflicts.map((row) => row.name)).toEqual(['second'])
    expect(outcome.failed.map((row) => row.name)).toEqual(['broken'])
    expect(await readFile(join(target, 'packable', 'references', 'deep.md'), 'utf8')).toContain('参考')
  })
})
