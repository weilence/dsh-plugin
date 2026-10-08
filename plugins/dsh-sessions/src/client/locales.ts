import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'dsh-sessions'
export type SessionsT = TranslateNS<typeof NS>

export const zh = {
  'section.label': '会话',
  import: '导入会话',
  'archive.title': '已归档会话',
  'archive.description':
    '归档不会删除数据，恢复仅取消归档；删除则永久移除日志文件。此处只显示当前连接的 DSH 实例中的归档。',
  'archive.search': '搜索标题、路径或会话 ID',
  'archive.loading': '正在加载归档列表…',
  'archive.unavailable': '归档列表尚不可用，请等待连接恢复后再试。',
  'archive.empty': '暂无已归档会话。',
  'archive.noMatch': '没有匹配的归档会话。',
  'archive.ungrouped': '未归属工作区',
  'archive.metadataLoading': '会话信息尚未加载。',
  'archive.metadataUnavailable': '当前列表暂无会话信息。取消归档不会重建已删除的数据。',
  'archive.updated': '最后更新：{time}',
  'archive.restore': '恢复',
  'archive.restoring': '正在恢复…',
  'archive.restored': '已取消归档：{title}',
  'archive.alreadyRestored': '此会话已不在归档列表中：{title}',
  'archive.delete': '删除',
  'archive.deleting': '正在删除…',
  'archive.deleteConfirmTitle': '删除归档会话',
  'archive.deleteConfirm':
    '将永久删除会话「{title}」的日志文件，不可恢复。不影响附件存储和其他会话；其子会话条目仍会保留。',
  'archive.deleted': '已删除：{title}',
  'archive.deletedNoFiles': '未找到日志文件，仅清除了归档条目：{title}',
  'archive.archiveClearFailed': '日志已删除，但清除归档条目失败：{detail}。可再次点击删除以清除条目。',
  'archive.refreshFailed': '已删除，但刷新会话列表失败：{detail}。刷新页面前侧栏可能仍显示该会话。',
  workspace: '目标工作区',
  'workspace.choose': '请选择工作区',
  'workspace.loading': '正在加载工作区…',
  'workspace.empty': '尚无工作区，请先在左侧列表中添加工作区。',
  'workspace.unavailable': '目标工作区不可用，请重新选择。',
  files: '会话 ZIP（可多选）',
  warning:
    '导入即确认 ZIP 来源可信。会话不会自动运行；继续会话后，历史权限设置和指令可能生效。只导入日志和附件，不迁移项目文件，也不替换历史文本中的旧路径。',
  working: '正在导入…',
  'result.done': '已导入 {imported} 个会话，跳过 {skipped} 个。若列表未更新，请刷新页面。',
  'result.failed':
    '导入未完成：{detail}。已导入 {imported} 个，跳过 {skipped} 个；未确认完整的会话：{incomplete}。请保留 ZIP 和错误详情，检查后再重试。',
  'result.refreshFailed': '刷新会话列表失败：{detail}。请刷新页面查看已保存的会话。',
  'file.tooLarge': 'ZIP 超过 64 MiB，无法导入。',
} as const

export type SessionsKey = keyof typeof zh
export const en: { [Key in SessionsKey]: string } = {
  'section.label': 'Sessions',
  import: 'Import sessions',
  'archive.title': 'Archived sessions',
  'archive.description':
    'Archiving keeps data; restoring only unarchives, while deleting permanently removes log files. Only archives on the currently connected DSH instance are shown.',
  'archive.search': 'Search titles, paths or session IDs',
  'archive.loading': 'Loading archived sessions…',
  'archive.unavailable':
    'The archive list is not available yet. Wait for the connection to recover and try again.',
  'archive.empty': 'No archived sessions.',
  'archive.noMatch': 'No matching archived sessions.',
  'archive.ungrouped': 'No workspace assignment',
  'archive.metadataLoading': 'Session information has not loaded yet.',
  'archive.metadataUnavailable':
    'No session information in the current list. Unarchiving does not recreate deleted data.',
  'archive.updated': 'Last updated: {time}',
  'archive.restore': 'Restore',
  'archive.restoring': 'Restoring…',
  'archive.restored': 'Unarchived: {title}',
  'archive.alreadyRestored': 'This session is no longer archived: {title}',
  'archive.delete': 'Delete',
  'archive.deleting': 'Deleting…',
  'archive.deleteConfirmTitle': 'Delete archived session',
  'archive.deleteConfirm':
    'This permanently deletes the log files of "{title}" and cannot be undone. Attachment storage and other sessions are not affected; its child session entries remain.',
  'archive.deleted': 'Deleted: {title}',
  'archive.deletedNoFiles': 'No log files found; only the archive entry was cleared: {title}',
  'archive.archiveClearFailed':
    'Logs deleted, but clearing the archive entry failed: {detail}. Click delete again to clear the entry.',
  'archive.refreshFailed':
    'Deleted, but refreshing the session list failed: {detail}. The sidebar may still list the session until the page is refreshed.',
  workspace: 'Target workspace',
  'workspace.choose': 'Select a workspace',
  'workspace.loading': 'Loading workspaces…',
  'workspace.empty': 'No workspaces yet. Add one in the sidebar first.',
  'workspace.unavailable': 'The target workspace is unavailable. Select it again.',
  files: 'Session ZIPs (multiple files allowed)',
  warning:
    'Importing confirms that you trust these ZIPs. Sessions do not run automatically; historical permissions and instructions may take effect when resumed. Only logs and attachments are imported, not project files. Paths in historical text remain unchanged.',
  working: 'Importing…',
  'result.done':
    'Imported {imported} sessions; skipped {skipped}. Refresh the page if the list has not updated.',
  'result.failed':
    'Import incomplete: {detail}. Imported {imported}; skipped {skipped}; sessions not confirmed complete: {incomplete}. Keep the ZIP and error details, and inspect the result before retrying.',
  'result.refreshFailed':
    'Refreshing the session list failed: {detail}. Refresh the page to see saved sessions.',
  'file.tooLarge': 'The ZIP exceeds the 64 MiB limit.',
}

export type Message = { key: SessionsKey; params?: Record<string, string | number> } | { text: string }

export function messageText(message: Message, t: SessionsT): string {
  return 'text' in message ? message.text : t(message.key, message.params)
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-sessions': SessionsKey
  }
}
