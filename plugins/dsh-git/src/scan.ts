import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { GitRepoInfo, GitRepoKind, GitRepoScan } from './shared'

/** 不下探的依赖与构建目录：体量大且不含用户仓库。 */
const PRUNED_DIRS = new Set([
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.yarn',
  '.venv',
  'venv',
  '.cache',
  '.gradle',
  '.turbo',
  '.next',
  '.nuxt',
  'target',
  'build',
  'dist',
  'out',
  'vendor',
  'Pods',
])

const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_DIRS = 20_000
const DEFAULT_MAX_REPOS = 500

const GITDIR_PREFIX = 'gitdir: '
const COMMIT_ID = /^[0-9a-f]{40}$/
const byRelPath = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export interface ScanOptions {
  maxDepth?: number
  maxDirs?: number
  maxRepos?: number
}

/**
 * 递归扫描 root 下的 Git 仓库。
 *
 * 判定：目录含 `.git` 目录（standard）或 `.git` 文件（linked，指向 worktree / 子模块的
 * git 目录）；目录本身直接含 HEAD + objects + refs 即裸仓库（bare）。发现仓库后继续下探
 * 工作树（可发现嵌套仓库与子模块），但不下探 `.git` 内部、剪枝目录与裸仓库内部；符号
 * 链接目录不跟随（readdir 的 dirent 判定对链接为 false）。子目录不可读即跳过，只有扫描
 * 根不可读才抛错。
 */
export async function scanGitRepositories(root: string, options: ScanOptions = {}): Promise<GitRepoScan> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxDirs = options.maxDirs ?? DEFAULT_MAX_DIRS
  const maxRepos = options.maxRepos ?? DEFAULT_MAX_REPOS
  const scanRoot = resolve(root)
  const repos: GitRepoInfo[] = []
  let truncated = false
  let visited = 0

  const budgetLeft = (): boolean => {
    if (visited < maxDirs && repos.length < maxRepos) return true
    truncated = true
    return false
  }

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (!budgetLeft()) return
    visited++
    let entries: readonly Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (dir === scanRoot) throw error
      return
    }
    const byName = new Map(entries.map((entry) => [entry.name, entry]))
    const gitEntry = byName.get('.git')
    let kind: GitRepoKind | undefined
    let gitDir: string | undefined
    if (gitEntry?.isDirectory()) {
      kind = 'standard'
      gitDir = join(dir, '.git')
    } else if (gitEntry?.isFile()) {
      kind = 'linked'
      gitDir = await resolveGitdirPointer(dir)
    } else if (
      byName.get('HEAD')?.isFile() &&
      byName.get('objects')?.isDirectory() &&
      byName.get('refs')?.isDirectory()
    ) {
      kind = 'bare'
      gitDir = dir
    }
    if (kind !== undefined) repos.push(await repoInfo(dir, kind, gitDir, scanRoot))
    if (kind === 'bare' || depth >= maxDepth) return
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || PRUNED_DIRS.has(entry.name)) continue
      await visit(join(dir, entry.name), depth + 1)
    }
  }

  await visit(scanRoot, 0)
  repos.sort((left, right) => byRelPath.compare(left.relPath, right.relPath))
  return { root: scanRoot, repos, truncated }
}

async function repoInfo(
  root: string,
  kind: GitRepoKind,
  gitDir: string | undefined,
  scanRoot: string,
): Promise<GitRepoInfo> {
  const info: GitRepoInfo = {
    root,
    name: basename(root),
    // relPath 是 wire / 展示字段，统一 / 分隔——Windows 的 path.relative 产出 \；
    // 用 split(sep) 而非替换字面反斜杠（POSIX 上它是合法文件名字符）
    relPath: relative(scanRoot, root).split(sep).join('/') || '.',
    kind,
  }
  if (gitDir === undefined) return info
  const [head, config] = await Promise.all([
    readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => undefined),
    readFile(join(gitDir, 'config'), 'utf8').catch(() => undefined),
  ])
  if (head !== undefined) {
    const ref = headRef(head)
    if (ref.branch !== undefined) info.branch = ref.branch
    else if (ref.head !== undefined) info.head = ref.head
  }
  if (config !== undefined) {
    const url = originUrl(config)
    if (url !== undefined) info.remote = url
  }
  return info
}

function headRef(head: string): { branch?: string; head?: string } {
  const value = head.trim()
  if (value.startsWith('ref: ')) {
    const ref = value.slice(5).trim()
    return { branch: ref.replace(/^refs\/heads\//, '') }
  }
  return COMMIT_ID.test(value) ? { head: value.slice(0, 7) } : {}
}

async function resolveGitdirPointer(repoRoot: string): Promise<string | undefined> {
  let content: string
  try {
    content = await readFile(join(repoRoot, '.git'), 'utf8')
  } catch {
    return undefined
  }
  const value = content.trim()
  return value.startsWith(GITDIR_PREFIX)
    ? resolve(repoRoot, value.slice(GITDIR_PREFIX.length).trim())
    : undefined
}

function originUrl(config: string): string | undefined {
  let inOrigin = false
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      inOrigin = line === '[remote "origin"]'
      continue
    }
    if (!inOrigin) continue
    const eq = line.indexOf('=')
    if (eq < 0 || line.slice(0, eq).trim().toLowerCase() !== 'url') continue
    const url = line.slice(eq + 1).trim()
    if (url.length > 0) return url
  }
  return undefined
}
