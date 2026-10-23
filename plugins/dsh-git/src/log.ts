import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitCommitFiles, GitCommitInfo, GitFileChange, GitLog } from './shared'

const exec = promisify(execFile)

// 字段/记录分隔符用 C0 控制字符，subject 与正文里的可见字符（含换行）不会与之冲突
const LOG_FORMAT = '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e'
const REF_FORMAT = '--format=%(HEAD)%00%(refname)%00%(objectname)'
const GIT_TIMEOUT_MS = 10_000
const MAX_BUFFER = 8 * 1024 * 1024

/** 空仓库：git log 在没有任何提交时以非零退出，语义上是空结果而非错误。 */
class NoCommitsError extends Error {}

interface RefLine {
  short: string
  kind: keyof typeof REF_NAMESPACES
  hash: string
  head: boolean
}

// ref 分类 → git 命名空间前缀；短名 = 去掉前缀
const REF_NAMESPACES = {
  branch: 'refs/heads/',
  remote: 'refs/remotes/',
  tag: 'refs/tags/',
} as const

// 只读查询不加索引锁，避免无谓的 .git/index 写入
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? text.trim()
}

async function runGit(repo: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: gitEnv(),
    })
    return stdout
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') throw new Error('git 不可用：PATH 中未找到 git 可执行文件')
    const stderr = (error as { stderr?: string } | null)?.stderr ?? ''
    if (stderr.includes('does not have any commits yet')) throw new NoCommitsError()
    throw new Error(firstLine(stderr) || (error instanceof Error ? error.message : String(error)))
  }
}

function parseLog(output: string) {
  const commits: {
    hash: string
    parents: string[]
    authorName: string
    authorEmail: string
    timestamp: number
    subject: string
    body: string
  }[] = []
  for (const record of output.split('\x1e')) {
    const trimmed = record.trim()
    if (trimmed.length === 0) continue
    const [hash, parents, authorName, authorEmail, timestamp, subject, body = ''] = trimmed.split('\x1f')
    commits.push({
      hash,
      parents: parents.length === 0 ? [] : parents.split(' '),
      authorName,
      authorEmail,
      timestamp: Number(timestamp),
      subject,
      body,
    })
  }
  return commits
}

function parseRefs(output: string): Map<string, RefLine[]> {
  const byHash = new Map<string, RefLine[]>()
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    const [headMark, refname, hash] = line.split('\0')
    const kind: keyof typeof REF_NAMESPACES | undefined = refname.startsWith(REF_NAMESPACES.branch)
      ? 'branch'
      : refname.startsWith(REF_NAMESPACES.remote)
        ? 'remote'
        : refname.startsWith(REF_NAMESPACES.tag)
          ? 'tag'
          : undefined
    if (kind === undefined) continue
    const short = refname.slice(REF_NAMESPACES[kind].length)
    const ref = { short, kind, hash, head: headMark === '*' }
    const bucket = byHash.get(hash)
    if (bucket === undefined) byHash.set(hash, [ref])
    else bucket.push(ref)
  }
  return byHash
}

/**
 * 读取仓库的提交图：git log 给拓扑序的提交与父链接，for-each-ref 给精确分类的
 * 分支 / 远端 / 标签及 HEAD 标记，两者在提交哈希上合并。
 */
export async function readGitLog(repo: string, limit: number): Promise<GitLog> {
  let logOutput: string
  let refOutput: string
  try {
    ;[logOutput, refOutput] = await Promise.all([
      runGit(repo, ['log', '--topo-order', '--all', '-n', String(limit + 1), LOG_FORMAT]),
      runGit(repo, ['for-each-ref', REF_FORMAT, 'refs/heads', 'refs/remotes', 'refs/tags']),
    ])
  } catch (error) {
    if (error instanceof NoCommitsError) return { commits: [], truncated: false }
    throw error
  }
  const parsed = parseLog(logOutput)
  const refs = parseRefs(refOutput)
  const commits: GitCommitInfo[] = parsed.slice(0, limit).map((commit) => {
    const decorated: GitCommitInfo = { ...commit, branches: [], remotes: [], tags: [] }
    for (const ref of refs.get(commit.hash) ?? []) {
      if (ref.kind === 'branch') decorated.branches.push(ref.short)
      else if (ref.kind === 'remote') decorated.remotes.push(ref.short)
      else decorated.tags.push(ref.short)
      if (ref.head && ref.kind === 'branch') decorated.headBranch = ref.short
    }
    return decorated
  })
  return { commits, truncated: parsed.length > limit }
}

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.*)$/

/** 解析 `git show --numstat -z`：每条记录一个 NUL 字段（`增\t删\t路径`），重命名
 *  记录路径为空、后跟旧路径与新路径两个 NUL 字段（实证顺序：old 在前）。 */
function parseNumstat(output: string): Map<string, { added?: number; deleted?: number; oldPath?: string }> {
  const byPath = new Map<string, { added?: number; deleted?: number; oldPath?: string }>()
  const fields = output.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const match = NUMSTAT.exec(fields[index]!)
    if (match === null) continue
    const added = match[1] === '-' ? undefined : Number(match[1])
    const deleted = match[2] === '-' ? undefined : Number(match[2])
    if (match[3].length > 0) {
      byPath.set(match[3], { added, deleted })
      continue
    }
    const oldPath = fields[index + 1]
    const newPath = fields[index + 2]
    if (oldPath !== undefined && newPath !== undefined) byPath.set(newPath, { added, deleted, oldPath })
    index += 2
  }
  return byPath
}

/** 解析 `git show --raw -z`：`:<mode> <mode> <sha> <sha> <状态>` 头 + 路径字段；R/C
 *  状态后跟旧路径与新路径（old 在前）。状态字母折并：T 并入 modified，C 并入 renamed。 */
function parseRawStatus(output: string): Map<string, GitFileChange['status']> {
  const byPath = new Map<string, GitFileChange['status']>()
  const fields = output.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!
    if (!field.startsWith(':')) continue
    const letter = field.split(' ')[4]?.[0]
    if (letter === undefined) continue
    const status: GitFileChange['status'] =
      letter === 'A'
        ? 'added'
        : letter === 'D'
          ? 'deleted'
          : letter === 'R' || letter === 'C'
            ? 'renamed'
            : 'modified'
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[index + 1]
      const newPath = fields[index + 2]
      if (oldPath !== undefined && newPath !== undefined) byPath.set(newPath, status)
      index += 2
    } else {
      const path = fields[index + 1]
      if (path !== undefined && path.length > 0) byPath.set(path, status)
    }
  }
  return byPath
}

/**
 * 读取单个提交的文件变更：numstat 给行数（二进制为 `-`），raw 给状态字母，按新路径
 * 合并；`--first-parent` 使合并提交展示相对第一父提交的变更（即合入的内容）。
 */
export async function readCommitFiles(repo: string, hash: string): Promise<GitCommitFiles> {
  const [numstatOutput, rawOutput] = await Promise.all([
    runGit(repo, ['show', '--first-parent', '--numstat', '-z', '--format=', hash]),
    runGit(repo, ['show', '--first-parent', '--raw', '-z', '--format=', hash]),
  ])
  const counts = parseNumstat(numstatOutput)
  const statuses = parseRawStatus(rawOutput)
  const files: GitFileChange[] = [...counts.entries()].map(([path, count]) => {
    const file: GitFileChange = { path, status: statuses.get(path) ?? 'modified' }
    if (count.added !== undefined) file.added = count.added
    if (count.deleted !== undefined) file.deleted = count.deleted
    if (count.oldPath !== undefined) file.oldPath = count.oldPath
    return file
  })
  return { hash, files }
}
