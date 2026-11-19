import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'dsh-sessions'
export type SessionsT = TranslateNS<typeof NS>

export const zh = {
  'menu.migrate': '迁移到工作区…',
  'menu.preset': '迁移预设…',
  'session.probeLoading': '正在检查会话加载状态…',
  'session.loadedBlocking':
    '会话已加载在宿主内存中（宿主在会话被打开后会持续持有，直至重启），请重启宿主后重试。',
  'migrate.disabledSubagent': '子会话不提供迁移，请迁移主会话。',
  'preset.disabledSubagent': '子会话不提供预设迁移。',
  workspace: '目标工作区',
  'workspace.choose': '请选择工作区',
  'workspace.loading': '正在加载工作区…',
  'workspace.unavailable': '目标工作区不可用，请重新选择。',
  'migrate.title': '迁移会话到工作区',
  'migrate.description':
    '迁移在磁盘上原地完成：日志头的工作目录改写为目标路径并移动文件，历史事件逐字节保留。工作目录已等于目标路径时只补挂工作区归属。会话必须空闲且未在宿主中加载，仍有回合、子代理、后台任务或定时活动时会被拒绝。历史文本中的旧路径保持原样。',
  'migrate.confirm': '迁移',
  'migrate.working': '正在迁移…',
  'migrate.done': '已迁移到「{workspace}」：{title}。若列表未更新，请刷新页面。',
  'migrate.attached': '工作目录与「{workspace}」一致，已直接归入：{title}。若列表未更新，请刷新页面。',
  'migrate.current': '当前所在工作区',
  'migrate.noTarget': '没有其他工作区可作为迁移目标；请先在左侧列表添加工作区。',
  'migrate.refreshFailed': '迁移完成，但刷新会话列表失败：{detail}。请刷新页面查看新工作区。',
  'preset.title': '迁移 Agent 预设',
  'preset.description':
    '把会话最后选择的 Agent 预设改写为指定预设（没有选择记录时改写日志头），消息历史保持不变；用于预设被改名或删除后无法恢复的会话。会话必须未在宿主中加载。',
  'preset.target': '目标预设',
  'preset.choose': '请选择预设',
  'preset.loading': '正在加载预设清单…',
  'preset.empty': '宿主没有已注册的预设。',
  'preset.confirm': '迁移',
  'preset.working': '正在迁移…',
  'preset.done': '已把「{title}」的预设从「{from}」迁移到「{to}」',
  'preset.unchanged': '「{title}」的预设已是「{preset}」，无需迁移',
} as const

export type SessionsKey = keyof typeof zh
export const en: { [Key in SessionsKey]: string } = {
  'menu.migrate': 'Migrate to workspace…',
  'menu.preset': 'Migrate preset…',
  'session.probeLoading': 'Checking whether the session is loaded…',
  'session.loadedBlocking':
    'The session is loaded in host memory (the host keeps it loaded once opened, until restart); restart the host and try again.',
  'migrate.disabledSubagent': 'Sub-sessions cannot be migrated; migrate the main session instead.',
  'preset.disabledSubagent': 'Preset migration is not offered for sub-sessions.',
  workspace: 'Target workspace',
  'workspace.choose': 'Select a workspace',
  'workspace.loading': 'Loading workspaces…',
  'workspace.unavailable': 'The target workspace is unavailable. Select it again.',
  'migrate.title': 'Migrate session to workspace',
  'migrate.description':
    'Migration happens in place on disk: the working directory in the log header is rewritten to the target path and the file is moved, with every history event preserved byte for byte. When the working directory already equals the target path, only workspace membership is repaired. The session must be idle and not loaded in the host; migration is refused while turns, subagents, background jobs, or scheduled activity are running. Old paths in historical text stay unchanged.',
  'migrate.confirm': 'Migrate',
  'migrate.working': 'Migrating…',
  'migrate.done': 'Migrated to "{workspace}": {title}. Refresh the page if the list has not updated.',
  'migrate.attached':
    'The working directory already matches "{workspace}"; the session was attached directly: {title}. Refresh the page if the list has not updated.',
  'migrate.current': 'Current workspace',
  'migrate.noTarget': 'No other workspace can be a migration target; add a workspace in the sidebar first.',
  'migrate.refreshFailed':
    'Migrated, but refreshing the session list failed: {detail}. Refresh the page to see the new workspace.',
  'preset.title': 'Migrate Agent preset',
  'preset.description':
    "Rewrites the session's latest selected Agent preset to the chosen one (or the log header when no selection exists); message history is untouched. Use it when a session cannot resume after its preset was renamed or removed. The session must not be loaded in the host.",
  'preset.target': 'Target preset',
  'preset.choose': 'Select a preset',
  'preset.loading': 'Loading presets…',
  'preset.empty': 'The host has no registered presets.',
  'preset.confirm': 'Migrate',
  'preset.working': 'Migrating…',
  'preset.done': 'Migrated the preset of "{title}" from "{from}" to "{to}"',
  'preset.unchanged': 'The preset of "{title}" is already "{preset}"; nothing to migrate',
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
