import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'dsh-sessions'
export type SessionsT = TranslateNS<typeof NS>

export const zh = {
  'section.label': '会话迁移',
  title: '会话迁移',
  subtitle: '导出完整会话 ZIP，离线恢复，或传输到已连接的远端。只新增，不覆盖现有会话。',
  source: '本机会话',
  choose: '请选择',
  refresh: '刷新列表',
  export: '导出 ZIP',
  'export.warning':
    '建议等待主会话和子会话停止运行后再导出。档案包含原始指令、工具输出和附件，未脱敏、未加密。',
  'export.done': '已将 ZIP 交给浏览器下载，请确认文件完整。',
  'local.title': '离线恢复',
  file: '选择宿主下载或本插件导出的 ZIP',
  'cwd.local': '本机目标工作目录（已存在的绝对路径）',
  'cwd.remote': '远端目标工作目录（已存在的绝对路径）',
  'remote.title': '传输到远端',
  'remote.target': '目标连接',
  'remote.missing':
    '请在本机启用新版 dsh-remote，并在「远程开发」中连接目标机器。远端也需启用 dsh-sessions。',
  'remote.empty': '尚未配置远端连接。请先在「远程开发」中添加并连接。',
  'remote.disconnected': '未连接',
  'remote.busy': '正在执行其他操作',
  'remote.connecting': '正在连接',
  'remote.stopping': '正在断开',
  'remote.error': '连接失败',
  'remote.invalid-tunnel': '隧道状态无效',
  preview: '预览导入',
  import: '确认导入',
  transfer: '确认传输',
  working: '处理中…',
  trust: '我确认档案来源可信，理解恢复后历史权限设置及指令可能生效。',
  'warning.environment':
    '只映射工作目录，不修改历史文本中的旧路径。不迁移项目文件、运行中的进程、定时任务或外部检查点；请先准备目标环境。',
  'warning.permissions':
    '导入不会自动运行会话。打开并继续后，日志中的权限设置（包括完全访问和禁用审批）及待处理消息可能生效。不要导入来源不明的档案。',
  'preview.heading': '预览结果：{count} 个会话',
  'status.new': '新增',
  'status.same': '已一致，跳过',
  'status.conflict': '内容不同，禁止覆盖',
  events: '{count} 条事件',
  'result.done': '已导入 {imported} 个会话，跳过 {skipped} 个。',
  'result.failed':
    '导入未完成：{detail}。已确认导入 {imported} 个；未确认完整的会话：{incomplete}。请重新预览，不要盲目重试。',
  'result.refreshFailed': '会话已保存，但刷新列表失败：{detail}。请刷新页面。',
  'title.failed': '标题读取失败：{detail}',
  'file.tooLarge': 'ZIP 超过 64 MiB，无法导入。',
  'preview.conflict': '存在冲突，不能导入。请保留两侧数据，在目标机器另开会话继续；本插件不会合并分叉历史。',
} as const

export type SessionsKey = keyof typeof zh
export const en: { [Key in SessionsKey]: string } = {
  'section.label': 'Session migration',
  title: 'Session migration',
  subtitle:
    'Export full session ZIPs, restore offline, or transfer to a connected remote. Existing sessions are never overwritten.',
  source: 'Local session',
  choose: 'Select…',
  refresh: 'Refresh lists',
  export: 'Export ZIP',
  'export.warning':
    'Wait for the root and its children to stop before exporting. Archives contain raw instructions, tool output and attachments; they are not redacted or encrypted.',
  'export.done': 'The ZIP was handed to the browser. Check that the download is complete.',
  'local.title': 'Offline restore',
  file: 'Choose a ZIP downloaded by DSH or exported here',
  'cwd.local': 'Local working directory (existing absolute path)',
  'cwd.remote': 'Remote working directory (existing absolute path)',
  'remote.title': 'Transfer to remote',
  'remote.target': 'Target connection',
  'remote.missing':
    'Enable an updated dsh-remote locally and connect under Remote development. Enable dsh-sessions on the remote too.',
  'remote.empty': 'No remote connections configured. Add and connect one under Remote development.',
  'remote.disconnected': 'Disconnected',
  'remote.busy': 'Another operation is in progress',
  'remote.connecting': 'Connecting',
  'remote.stopping': 'Disconnecting',
  'remote.error': 'Connection failed',
  'remote.invalid-tunnel': 'Invalid tunnel state',
  preview: 'Preview import',
  import: 'Confirm import',
  transfer: 'Confirm transfer',
  working: 'Working…',
  trust:
    'I trust this archive and understand that its historical permissions and instructions may take effect after resuming.',
  'warning.environment':
    'Only the working directory is mapped; historical paths remain unchanged. Project files, running processes, schedules and external checkpoints are not migrated. Prepare the target environment first.',
  'warning.permissions':
    'Import does not run sessions. Opening and continuing may restore logged permissions (including full access and disabled approvals) and pending messages. Do not import untrusted archives.',
  'preview.heading': 'Preview: {count} sessions',
  'status.new': 'Create',
  'status.same': 'Identical; skip',
  'status.conflict': 'Different; cannot overwrite',
  events: '{count} events',
  'result.done': 'Imported {imported} sessions; skipped {skipped}.',
  'result.failed':
    'Import incomplete: {detail}. Confirmed imports: {imported}; sessions not confirmed complete: {incomplete}. Preview again; do not retry blindly.',
  'result.refreshFailed': 'Sessions were saved, but refreshing the list failed: {detail}. Refresh the page.',
  'title.failed': 'Reading the title failed: {detail}',
  'file.tooLarge': 'The ZIP exceeds the 64 MiB limit.',
  'preview.conflict':
    'Conflicts prevent import. Keep both copies and continue in a new session on the target. This plugin does not merge divergent histories.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-sessions': SessionsKey
  }
}
