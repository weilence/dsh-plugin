import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanGitRepositories } from '../../src/scan'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-git-scan-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makeStandardRepo(dir: string, facts: { head?: string; origin?: string } = {}): Promise<void> {
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'HEAD'), facts.head ?? 'ref: refs/heads/main\n')
  if (facts.origin !== undefined) {
    await writeFile(
      join(dir, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${facts.origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    )
  }
}

async function makeBareRepo(dir: string): Promise<void> {
  await mkdir(join(dir, 'objects'), { recursive: true })
  await mkdir(join(dir, 'refs'), { recursive: true })
  await writeFile(join(dir, 'HEAD'), 'ref: refs/heads/main\n')
}

describe('Git 仓库扫描', () => {
  it('识别标准仓库、.git 文件工作树与裸仓库，并读出分支、提交与远端', async () => {
    await makeStandardRepo(join(root, 'alpha'), { origin: 'git@example.com:weilence/alpha.git' })
    await makeStandardRepo(join(root, 'beta'))
    await mkdir(join(root, 'beta-worktree'), { recursive: true })
    await mkdir(join(root, 'beta', '.git', 'worktrees', 'wt'), { recursive: true })
    await writeFile(join(root, 'beta', '.git', 'worktrees', 'wt', 'HEAD'), 'a'.repeat(40) + '\n')
    await writeFile(
      join(root, 'beta-worktree', '.git'),
      `gitdir: ${join(root, 'beta', '.git', 'worktrees', 'wt')}\n`,
    )
    await makeBareRepo(join(root, 'gamma.git'))

    const scan = await scanGitRepositories(root)
    expect(scan.root).toBe(root)
    expect(scan.truncated).toBe(false)
    expect(scan.repos).toEqual([
      {
        root: join(root, 'alpha'),
        name: 'alpha',
        relPath: 'alpha',
        kind: 'standard',
        branch: 'main',
        remote: 'git@example.com:weilence/alpha.git',
      },
      {
        root: join(root, 'beta'),
        name: 'beta',
        relPath: 'beta',
        kind: 'standard',
        branch: 'main',
      },
      {
        root: join(root, 'beta-worktree'),
        name: 'beta-worktree',
        relPath: 'beta-worktree',
        kind: 'linked',
        head: 'a'.repeat(7),
      },
      {
        root: join(root, 'gamma.git'),
        name: 'gamma.git',
        relPath: 'gamma.git',
        kind: 'bare',
        branch: 'main',
      },
    ])
  })

  it('发现仓库后继续下探，嵌套仓库与子模块形态一并列出', async () => {
    await makeStandardRepo(join(root, 'outer'))
    await makeStandardRepo(join(root, 'outer', 'inner'))
    await mkdir(join(root, 'outer', 'submodule'), { recursive: true })
    await writeFile(join(root, 'outer', 'submodule', '.git'), 'gitdir: ../../.git/modules/sub\n')

    const scan = await scanGitRepositories(root)
    expect(scan.repos.map((repo) => repo.relPath)).toEqual(['outer', 'outer/inner', 'outer/submodule'])
    expect(scan.repos.map((repo) => repo.kind)).toEqual(['standard', 'standard', 'linked'])
  })

  it('剪枝依赖与构建目录，不进入 .git 内部与裸仓库内部', async () => {
    await makeStandardRepo(join(root, 'repo'))
    await makeStandardRepo(join(root, 'repo', 'node_modules', 'hidden'))
    await makeStandardRepo(join(root, 'repo', '.git', 'objects', 'hidden'))
    await makeBareRepo(join(root, 'bare.git'))
    await makeStandardRepo(join(root, 'bare.git', 'objects', 'hidden'))

    const scan = await scanGitRepositories(root)
    expect(scan.repos.map((repo) => repo.relPath)).toEqual(['bare.git', 'repo'])
  })

  it('深度之外不访问且不算截断；目录与仓库上限触发截断', async () => {
    await makeStandardRepo(join(root, 'one', 'two', 'deep'))

    const shallow = await scanGitRepositories(root, { maxDepth: 2 })
    expect(shallow.repos).toEqual([])
    expect(shallow.truncated).toBe(false)

    const capped = await scanGitRepositories(root, { maxDirs: 1 })
    expect(capped.truncated).toBe(true)

    await makeStandardRepo(join(root, 'second'))
    const limited = await scanGitRepositories(root, { maxRepos: 1 })
    expect(limited.repos).toHaveLength(1)
    expect(limited.truncated).toBe(true)
  })

  it('符号链接目录不跟随', async () => {
    await makeStandardRepo(join(root, 'real'))
    await symlink(root, join(root, 'real', 'loop'))

    const scan = await scanGitRepositories(root)
    expect(scan.repos.map((repo) => repo.relPath)).toEqual(['real'])
  })

  it('扫描根本身是仓库时 relPath 为「.」，子仓库照常列出', async () => {
    await makeStandardRepo(root, { head: 'ref: refs/heads/develop\n' })
    await makeStandardRepo(join(root, 'child'))

    const scan = await scanGitRepositories(root)
    expect(scan.repos.map((repo) => repo.relPath)).toEqual(['.', 'child'])
    expect(scan.repos[0]?.branch).toBe('develop')
  })

  it('.git 文件内容无效时仍列出仓库，但无分支与远端', async () => {
    await mkdir(join(root, 'broken'), { recursive: true })
    await writeFile(join(root, 'broken', '.git'), 'not a gitdir pointer\n')

    const scan = await scanGitRepositories(root)
    expect(scan.repos).toEqual([
      { root: join(root, 'broken'), name: 'broken', relPath: 'broken', kind: 'linked' },
    ])
  })

  it('结果按相对路径自然排序', async () => {
    for (const name of ['repo10', 'repo2', 'repo1']) await makeStandardRepo(join(root, name))

    const scan = await scanGitRepositories(root)
    expect(scan.repos.map((repo) => repo.relPath)).toEqual(['repo1', 'repo2', 'repo10'])
  })

  it('扫描根不存在时抛错', async () => {
    await expect(scanGitRepositories(join(root, 'missing'))).rejects.toThrow()
  })
})
