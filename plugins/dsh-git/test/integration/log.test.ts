import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCommitFiles, readGitLog } from '../../src/log'

const exec = promisify(execFile)
let root: string

async function git(dir: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', dir, ...args], { env: gitEnv() })
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Li Lei',
    GIT_AUTHOR_EMAIL: 'lilei@example.com',
    GIT_COMMITTER_NAME: 'Li Lei',
    GIT_COMMITTER_EMAIL: 'lilei@example.com',
  }
}

async function commit(dir: string, date: string, subject: string): Promise<void> {
  await exec('git', ['-C', dir, 'commit', '--allow-empty', '-m', subject], {
    env: { ...gitEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-git-log-'))
})

afterEach(async () => {
  // Windows 上刚退出的 git 子进程的 cwd 句柄释放有滞后（杀软扫描也会短暂持有），
  // rm 会偶发 EBUSY；maxRetries 内建重试恰好覆盖，POSIX 无错误时不触发——同一写法两平台一致
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('git log 读取', () => {
  it('拓扑序返回提交与父链接，合并 HEAD 分支、远端与标签', async () => {
    const repo = join(root, 'repo')
    await mkdir(repo)
    await git(repo, 'init', '-b', 'main')
    await commit(repo, '2023-11-14T12:00:00+00:00', 'init')
    await git(repo, 'checkout', '-b', 'feature')
    await commit(repo, '2023-11-14T12:01:00+00:00', 'add feature')
    await git(repo, 'checkout', 'main')
    await commit(repo, '2023-11-14T12:02:00+00:00', 'main work')
    await git(repo, 'merge', '--no-ff', 'feature', '-m', 'merge feature')
    await git(repo, 'tag', 'v1.0.0')
    await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')

    const log = await readGitLog(repo, 500)
    expect(log.truncated).toBe(false)
    expect(log.commits).toHaveLength(4)
    expect(log.commits.map((entry) => entry.subject)).toEqual([
      'merge feature',
      'add feature',
      'main work',
      'init',
    ])

    const merge = log.commits[0]!
    expect(merge.parents).toHaveLength(2)
    expect(merge.headBranch).toBe('main')
    expect(merge.branches).toEqual(['main'])
    expect(merge.remotes).toEqual(['origin/main'])
    expect(merge.tags).toEqual(['v1.0.0'])
    expect(merge.authorName).toBe('Li Lei')
    expect(merge.authorEmail).toBe('lilei@example.com')
    // merge 未固定日期，作者时间为执行时刻，晚于最后一个固定日期提交
    expect(merge.timestamp).toBeGreaterThan(Math.round(Date.parse('2023-11-14T12:02:00Z') / 1000))

    const feature = log.commits.find((entry) => entry.subject === 'add feature')!
    expect(feature.branches).toEqual(['feature'])

    const init = log.commits.at(-1)!
    expect(init.parents).toEqual([])
    expect(init.timestamp).toBe(Math.round(Date.parse('2023-11-14T12:00:00Z') / 1000))
  })

  it('limit 截断置 truncated，空仓库返回空列表', async () => {
    const repo = join(root, 'repo')
    await mkdir(repo)
    await git(repo, 'init', '-b', 'main')
    await expect(readGitLog(repo, 500)).resolves.toEqual({ commits: [], truncated: false })

    await commit(repo, '2023-11-14T12:00:00+00:00', 'one')
    await commit(repo, '2023-11-14T12:01:00+00:00', 'two')
    await commit(repo, '2023-11-14T12:02:00+00:00', 'three')
    const limited = await readGitLog(repo, 2)
    expect(limited.commits.map((entry) => entry.subject)).toEqual(['three', 'two'])
    expect(limited.truncated).toBe(true)
  })

  it('非 git 目录报错保留 git 的原因', async () => {
    const dir = join(root, 'plain')
    await mkdir(dir)
    await expect(readGitLog(dir, 500)).rejects.toThrow(/not a git repository/i)
  })

  it('读取单个提交的文件变更：状态、行数、重命名与二进制', async () => {
    const repo = join(root, 'files-repo')
    await mkdir(repo)
    await git(repo, 'init', '-b', 'main')
    await writeFile(join(repo, 'OLDFILE.md'), 'one\ntwo\nthree\n')
    await writeFile(join(repo, 'BINFILE.bin'), '\x00\x01\x02')
    await git(repo, 'add', '.')
    await commit(repo, '2023-11-14T12:00:00+00:00', 'root')

    const rootFiles = await readCommitFiles(repo, 'HEAD')
    expect(rootFiles.files).toHaveLength(2)
    expect(rootFiles.files).toContainEqual({ path: 'OLDFILE.md', status: 'added', added: 3, deleted: 0 })
    expect(rootFiles.files).toContainEqual({ path: 'BINFILE.bin', status: 'added' })

    await git(repo, 'mv', 'OLDFILE.md', 'NEWFILE.md')
    await writeFile(join(repo, 'NEWFILE.md'), 'one\ntwo\nthree\nfour\n')
    await writeFile(join(repo, 'CFILE.txt'), 'new\n')
    await rm(join(repo, 'BINFILE.bin'))
    await git(repo, 'add', '.')
    await commit(repo, '2023-11-14T12:01:00+00:00', 'changes')

    const changeFiles = await readCommitFiles(repo, 'HEAD')
    expect(changeFiles.files).toHaveLength(3)
    expect(changeFiles.files).toContainEqual({
      path: 'NEWFILE.md',
      oldPath: 'OLDFILE.md',
      status: 'renamed',
      added: 1,
      deleted: 0,
    })
    expect(changeFiles.files).toContainEqual({ path: 'CFILE.txt', status: 'added', added: 1, deleted: 0 })
    expect(changeFiles.files).toContainEqual({ path: 'BINFILE.bin', status: 'deleted' })
  })

  it('合并提交按第一父提交展示合入的文件变更', async () => {
    const repo = join(root, 'merge-repo')
    await mkdir(repo)
    await git(repo, 'init', '-b', 'main')
    await writeFile(join(repo, 'base.txt'), 'base\n')
    await git(repo, 'add', '.')
    await commit(repo, '2023-11-14T12:00:00+00:00', 'base')
    await git(repo, 'checkout', '-b', 'feature')
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, 'add', '.')
    await commit(repo, '2023-11-14T12:01:00+00:00', 'feature work')
    await git(repo, 'checkout', 'main')
    await writeFile(join(repo, 'mainside.txt'), 'main\n')
    await git(repo, 'add', '.')
    await commit(repo, '2023-11-14T12:02:00+00:00', 'main side')
    await git(repo, 'merge', '--no-ff', 'feature', '-m', 'merge feature')

    const merged = await readCommitFiles(repo, 'HEAD')
    expect(merged.files).toEqual([{ path: 'feature.txt', status: 'added', added: 1, deleted: 0 }])
  })
})
