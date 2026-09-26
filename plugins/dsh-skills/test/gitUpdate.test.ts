import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cloneToTemp, discoverRepoSkills, headCommit, installCandidates, treeHash } from '../src/gitInstall'
import { readGitIndex, writeGitIndex } from '../src/gitMeta'
import { applyGitUpdates, checkGitUpdates, recordInstalls } from '../src/gitUpdate'
import type { RootId } from '../src/shared'

const execFileAsync = promisify(execFile)

/** git 快捷封装（自动带测试身份）。 */
function gitOf(repo: string): (args: string[]) => Promise<unknown> {
  return (args) => execFileAsync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
}

/** 造仓库并做一次初始提交。 */
async function gitInit(repo: string): Promise<void> {
  const git = gitOf(repo)
  await git(['init', '-q'])
  await git(['add', '-A'])
  await git(['commit', '-qm', 'init'])
}

/** 追加一次提交。 */
async function gitCommit(repo: string, message: string): Promise<void> {
  const git = gitOf(repo)
  await git(['add', '-A'])
  await git(['commit', '-qm', message])
}

function fileUrlOf(path: string): string {
  return `file:///${path.replaceAll('\\', '/')}`
}

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n正文。\n`
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

let work: string

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'dsh-skills-update-test-'))
})

afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

describe('gitMeta：根级索引读写', () => {
  it('缺失 / 损坏回空索引；读写往返保留记录', async () => {
    const root = join(work, 'meta-root')
    expect((await readGitIndex(root)).skills).toEqual({})
    await write(join(root, '.dsh-skills.json'), '{ not json')
    expect((await readGitIndex(root)).skills).toEqual({})
    await writeGitIndex(root, {
      version: 1,
      skills: {
        alpha: {
          url: 'https://github.com/a/b',
          dir: 'skills/alpha',
          origin: 'skills',
          commit: 'ab'.repeat(20),
          contentHash: 'deadbeef',
          installedAt: '2025-01-01T00:00:00.000Z',
        },
      },
    })
    const loaded = await readGitIndex(root)
    expect(loaded.skills['alpha']?.dir).toBe('skills/alpha')
    expect(loaded.skills['alpha']?.commit).toBe('ab'.repeat(20))
  })
})

describe('treeHash / headCommit', () => {
  it('内容指纹与文件顺序 / mtime 无关，内容变化可检出', async () => {
    const left = join(work, 'hash-left')
    const right = join(work, 'hash-right')
    await write(join(left, 'a.md'), 'A')
    await write(join(left, 'sub', 'b.md'), 'B')
    await write(join(right, 'sub', 'b.md'), 'B')
    await write(join(right, 'a.md'), 'A')
    expect(await treeHash(left)).toBe(await treeHash(right))
    await write(join(right, 'a.md'), 'A2')
    expect(await treeHash(left)).not.toBe(await treeHash(right))
  })

  it('headCommit 返回 40 位提交号', async () => {
    const repo = join(work, 'commit-repo')
    await write(join(repo, 'README.md'), '# r')
    await gitInit(repo)
    expect(await headCommit(repo)).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('安装登记与更新跟踪（真实 git 仓库）', () => {
  it('current → update → local → 覆盖更新 → removed 全链路', async () => {
    const repo = join(work, 'track-repo')
    await write(join(repo, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', '第一版描述'))
    await gitInit(repo)
    const url = fileUrlOf(repo)

    // 安装（用仓库本体当 sourceRoot / temp：headCommit 与 treeHash 都可用）。
    const rootPath = join(work, 'track-root')
    const candidates = (await discoverRepoSkills(repo)).skills
    const outcome = await installCandidates({ id: 'user-agents', path: rootPath }, candidates, repo)
    expect(outcome.installed.map((row) => row.name)).toEqual(['alpha'])
    await recordInstalls(rootPath, url, repo, candidates, ['alpha'])
    const record = (await readGitIndex(rootPath)).skills['alpha']
    expect(record?.url).toBe(url)
    expect(record?.dir).toBe('skills/alpha')
    expect(record?.commit).toMatch(/^[0-9a-f]{40}$/)

    const roots = [{ id: 'user-agents' as RootId, path: rootPath }]

    // ① 安装后立即检查：已最新（commit 快路径）。
    let check = await checkGitUpdates(roots)
    expect(check.repoErrors).toEqual([])
    expect(check.results[0]).toMatchObject({ name: 'alpha', status: 'current' })

    // ② 上游改内容并提交：有更新（附上游描述）。
    await write(join(repo, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', '第二版描述'))
    await gitCommit(repo, 'bump alpha')
    check = await checkGitUpdates(roots)
    expect(check.results[0]).toMatchObject({ name: 'alpha', status: 'update' })
    expect(check.results[0].description).toBe('第二版描述')

    // ③ 本地也改过：本地已修改。
    await write(join(rootPath, 'alpha', 'SKILL.md'), skillMd('alpha', '本地改'))
    check = await checkGitUpdates(roots)
    expect(check.results[0]).toMatchObject({ name: 'alpha', status: 'local' })

    // ④ 应用更新：内容换成上游版，索引刷新，staging 不残留。
    const update = await applyGitUpdates(roots, [{ rootId: 'user-agents', name: 'alpha' }])
    expect(update.repoErrors).toEqual([])
    expect(update.failed).toEqual([])
    expect(update.updated.map((row) => row.name)).toEqual(['alpha'])
    expect(await readFile(join(rootPath, 'alpha', 'SKILL.md'), 'utf8')).toContain('第二版描述')
    expect(await pathExists(join(rootPath, 'alpha.dsh-update'))).toBe(false)
    check = await checkGitUpdates(roots)
    expect(check.results[0]).toMatchObject({ name: 'alpha', status: 'current' })
    const refreshed = (await readGitIndex(rootPath)).skills['alpha']
    expect(refreshed?.commit).not.toBe(record?.commit)
    expect(refreshed?.contentHash).toBe(await treeHash(join(rootPath, 'alpha')))

    // ⑤ 上游删目录：removed；无记录 / 未知根的应用请求失败。
    await rm(join(repo, 'skills', 'alpha'), { recursive: true, force: true })
    await gitCommit(repo, 'drop alpha')
    check = await checkGitUpdates(roots)
    expect(check.results[0]).toMatchObject({ name: 'alpha', status: 'removed' })
    const bad = await applyGitUpdates(roots, [
      { rootId: 'user-agents', name: 'ghost' },
      { rootId: 'project-dsh', name: 'alpha' },
    ])
    expect(bad.updated).toEqual([])
    expect(bad.failed).toHaveLength(2)
  })

  it('克隆失败的仓库只影响其名下技能（repoErrors）', async () => {
    const rootPath = join(work, 'broken-root')
    await writeGitIndex(rootPath, {
      version: 1,
      skills: {
        lone: {
          url: fileUrlOf(join(work, 'does-not-exist')),
          dir: 'skills/lone',
          origin: 'skills',
          installedAt: '2025-01-01T00:00:00.000Z',
        },
      },
    })
    await write(join(rootPath, 'lone', 'SKILL.md'), skillMd('lone', '本地技能'))
    const check = await checkGitUpdates([{ id: 'user-agents', path: rootPath }])
    expect(check.results).toEqual([])
    expect(check.repoErrors).toHaveLength(1)
    expect(check.repoErrors[0]?.error.length ?? 0).toBeGreaterThan(0)
  })
})
