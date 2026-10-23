import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'dsh-git'
export type GitT = TranslateNS<typeof NS>

export const zh = {
  'type.label': 'Git 仓库',
  'guide.title': 'Git 仓库',
  'guide.description': '递归扫描当前会话目录，图形化查看全部 Git 仓库的提交历史',
  refresh: '刷新',
  'scan.loading': '正在扫描…',
  'scan.empty': '此目录下未发现 Git 仓库。',
  'scan.noCwd': '当前会话尚未提供工作目录，无法扫描。',
  'scan.truncated': '仓库数量超过扫描上限，未全部列出。',
  'repo.bare': '裸仓库',
  'repo.linked': '关联工作树',
  'repo.select': '选择仓库',
  'log.loading': '正在读取提交…',
  'log.empty': '此仓库还没有提交。',
  'log.count': '{count} 个提交',
  'log.truncated': '提交超过读取上限，未全部显示。',
  'log.filesLoading': '正在读取文件变更…',
  'log.files': '{count} 个文件变更',
  'log.noFiles': '此提交没有文件变更。',
} as const

export type GitKey = keyof typeof zh
export const en: { [Key in GitKey]: string } = {
  'type.label': 'Git repositories',
  'guide.title': 'Git repositories',
  'guide.description':
    'Recursively scan the session directory and browse commit history of every Git repository as a graph',
  refresh: 'Refresh',
  'scan.loading': 'Scanning…',
  'scan.empty': 'No Git repositories found under this directory.',
  'scan.noCwd': 'The current session has no working directory yet, so there is nothing to scan.',
  'scan.truncated': 'Repositories exceed the scan limit; not all are listed.',
  'repo.bare': 'bare repository',
  'repo.linked': 'linked worktree',
  'repo.select': 'Choose a repository',
  'log.loading': 'Reading commits…',
  'log.empty': 'This repository has no commits yet.',
  'log.count': '{count} commits',
  'log.truncated': 'Commits exceed the read limit; not all are shown.',
  'log.filesLoading': 'Reading file changes…',
  'log.files': '{count} changed files',
  'log.noFiles': 'This commit has no file changes.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-git': GitKey
  }
}
