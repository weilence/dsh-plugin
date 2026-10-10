import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'dsh-sessions'
export type SessionsT = TranslateNS<typeof NS>

export const zh = {
  'section.label': '会话',
  'panel.subtitle': '把导出的会话 ZIP 导入为归档会话，并管理归档的恢复与删除。',
  import: '导入会话',
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
  migrate: '迁移到工作区…',
  'migrate.title': '迁移会话到工作区',
  'migrate.description':
    '迁移会把该会话及其子会话导出为官方 ZIP，删除本机原日志，再导入到目标工作区；日志头的工作目录会改写为目标路径，历史文本中的旧路径保持原样。会话必须空闲且未在宿主中加载，仍有回合、子代理、后台任务或定时活动时会被拒绝。迁移不是原子操作，中途失败时按提示用导出档案恢复。',
  'migrate.confirm': '迁移',
  'migrate.working': '正在迁移…',
  'migrate.done': '已迁移到「{workspace}」：{title}。若列表未更新，请刷新页面。',
  'migrate.attached': '工作目录与「{workspace}」一致，已直接归入：{title}。若列表未更新，请刷新页面。',
  'migrate.current': '当前所在工作区',
  'migrate.noTarget': '没有其他工作区可作为迁移目标；请先在左侧列表添加工作区。',
  'migrate.refreshFailed': '迁移完成，但刷新会话列表失败：{detail}。请刷新页面查看新工作区。',
  'migrate.archiveClearFailed':
    '已迁移，但会话仍留在归档集中：{detail}。可在「设置 → 会话」的归档列表中点击恢复。',
  'migrate.loadedFailed': '会话仍加载在宿主内存中，未做任何改动。请重启宿主或确认已关闭该会话后重试。',
  'migrate.activityFailed': '会话仍有进行中的活动，已拒绝迁移：{detail}',
  'migrate.attachFailed': '归入工作区失败，未做任何改动：{detail}',
  'migrate.exportFailed': '导出会话日志失败，未做任何改动：{detail}',
  'migrate.archiveFailed': '归档会话失败，未做任何改动：{detail}',
  'migrate.deleteFailed': '日志删除失败，目标工作区未导入：{detail}',
  'migrate.importFailed': '日志已删除，但导入目标工作区失败：{detail}',
  'migrate.recoverHint': '已保留导出档案，可用「设置 → 会话」的导入功能恢复到目标目录 {cwd}。',
  'migrate.recover': '下载导出档案',
} as const

export type SessionsKey = keyof typeof zh
export const en: { [Key in SessionsKey]: string } = {
  'section.label': 'Sessions',
  'panel.subtitle':
    'Import exported session ZIPs as archived sessions, and manage restoring or deleting them.',
  import: 'Import sessions',
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
  migrate: 'Migrate to workspace…',
  'migrate.title': 'Migrate session to workspace',
  'migrate.description':
    'Migration exports the session and its sub-sessions as an official ZIP, deletes the local logs, then imports them into the target workspace; the working directory in the log header is rewritten to the target path, while old paths in historical text stay unchanged. The session must be idle and not loaded in the host; migration is refused while turns, subagents, background jobs, or scheduled activity are running. Migration is not atomic; if it fails midway, recover with the exported archive as instructed.',
  'migrate.confirm': 'Migrate',
  'migrate.working': 'Migrating…',
  'migrate.done': 'Migrated to "{workspace}": {title}. Refresh the page if the list has not updated.',
  'migrate.attached':
    'The working directory already matches "{workspace}"; the session was attached directly: {title}. Refresh the page if the list has not updated.',
  'migrate.current': 'Current workspace',
  'migrate.noTarget': 'No other workspace can be a migration target; add a workspace in the sidebar first.',
  'migrate.refreshFailed':
    'Migrated, but refreshing the session list failed: {detail}. Refresh the page to see the new workspace.',
  'migrate.archiveClearFailed':
    'Migrated, but the session remains in the archive set: {detail}. Click restore in the archived list under Settings → Sessions.',
  'migrate.loadedFailed':
    'The session is still loaded in the host memory; nothing was changed. Restart the host or make sure the session is closed, then retry.',
  'migrate.activityFailed': 'The session still has running activity; migration was refused: {detail}',
  'migrate.attachFailed': 'Attaching to the workspace failed; nothing was changed: {detail}',
  'migrate.exportFailed': 'Exporting the session log failed; nothing was changed: {detail}',
  'migrate.archiveFailed': 'Archiving the session failed; nothing was changed: {detail}',
  'migrate.deleteFailed': 'Deleting the logs failed; the target workspace was not imported: {detail}',
  'migrate.importFailed': 'The logs were deleted, but importing into the target workspace failed: {detail}',
  'migrate.recoverHint':
    'The exported archive is preserved; restore it into the target directory {cwd} via "Settings → Sessions" import.',
  'migrate.recover': 'Download exported archive',
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
