export const REPOS_PATH = '/plugins/dsh-git/repos'
export const LOG_PATH = '/plugins/dsh-git/log'
export const FILES_PATH = '/plugins/dsh-git/files'
export const GIT_HEADER = 'x-dsh-git'

export const DEFAULT_LOG_LIMIT = 500
export const MAX_LOG_LIMIT = 1000

/** 仓库形态：.git 目录（standard）、.git 文件指向外部 git 目录（linked，worktree / 子模块）、裸仓库（bare）。 */
export type GitRepoKind = 'standard' | 'linked' | 'bare'

export interface GitRepoInfo {
  /** 仓库根目录绝对路径；裸仓库即仓库目录本身。 */
  root: string
  /** 根目录名。 */
  name: string
  /** 相对扫描根的路径；扫描根本身是仓库时为 '.'。 */
  relPath: string
  kind: GitRepoKind
  /** HEAD 解析出的分支名；detached HEAD 时缺省。 */
  branch?: string
  /** detached HEAD 的短提交号。 */
  head?: string
  /** origin 远端 URL。 */
  remote?: string
}

export interface GitRepoScan {
  /** 扫描根绝对路径。 */
  root: string
  repos: GitRepoInfo[]
  /** 目录或仓库数量超过扫描上限时为 true；深度之外未访问的目录不算截断。 */
  truncated: boolean
}

export interface GitRepoScanRequest {
  cwd: string
}

export interface GitCommitInfo {
  hash: string
  /** 父提交，拓扑序在前；多父即合并提交。 */
  parents: string[]
  authorName: string
  authorEmail: string
  /** 作者时间，Unix 秒。 */
  timestamp: number
  subject: string
  /** 当前检出的本地分支短名；HEAD 指向的提交上给出。 */
  headBranch?: string
  /** 指向该提交的本地分支短名。 */
  branches: string[]
  /** 指向该提交的远端分支（含 remote 名，如 origin/main）。 */
  remotes: string[]
  /** 指向该提交的标签短名。 */
  tags: string[]
}

export interface GitLog {
  commits: GitCommitInfo[]
  /** 超出 limit 的提交未包含。 */
  truncated: boolean
}

export interface GitLogRequest {
  repo: string
  limit?: number
}

export interface GitFileChange {
  /** 变更后路径；重命名即新路径。 */
  path: string
  /** 重命名的旧路径；非重命名缺省。 */
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  /** 新增行数；二进制文件缺省。 */
  added?: number
  /** 删除行数；二进制文件缺省。 */
  deleted?: number
}

export interface GitCommitFiles {
  hash: string
  files: GitFileChange[]
}

export interface GitCommitFilesRequest {
  repo: string
  hash: string
}
