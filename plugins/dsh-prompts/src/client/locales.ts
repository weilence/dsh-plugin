import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的词典命名空间：注册进宿主 locale 服务，语言选择与回退由其统一裁决。 */
export const NS = 'dsh-prompts'

export type PromptsT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  'section.label': '全局提示词',
  title: '全局提示词',
  subtitle: '编辑用户级 AGENTS.md；工作区指令和系统提示词不受影响。',
  'load.failed': '读取全局提示词失败：{detail}',
  'save.failed': '保存失败：{detail}',
  'delete.failed': '删除失败：{detail}',
  'confirm.refresh': '刷新会丢弃尚未保存的修改，确定继续吗？',
  'confirm.delete': '确定删除 {path} 吗？此操作不可撤销。',
  'notice.saved': '全局提示词已保存',
  'notice.deleted': '全局提示词已删除',
  'path.label': '文件路径',
  'path.loading': '读取中…',
  'path.unavailable': '路径不可用',
  'path.absent': '文件尚不存在，保存后将创建。',
  'editor.label': '提示词正文（Markdown）',
  'editor.placeholder': '在此编写适用于所有工作区的指令…',
  processing: '处理中…',
  create: '创建',
  refresh: '刷新',
  'button.deleteFile': '删除文件',
  'delete.dirtyTitle': '请先保存或刷新未保存的修改',
  hint: '请确认文件路径与智能体使用的全局目录一致。保存时会检查外部修改；若有冲突，请刷新并自行合并。新内容在下一次尚未开始的模型步骤生效。',
} as const

export type PromptsKey = keyof typeof zh

export const en: { [Key in PromptsKey]: string } = {
  'section.label': 'Global prompt',
  title: 'Global prompt',
  subtitle: 'Edit the user-level AGENTS.md; workspace instructions and the system prompt are unaffected.',
  'load.failed': 'Reading the global prompt failed: {detail}',
  'save.failed': 'Saving failed: {detail}',
  'delete.failed': 'Deleting failed: {detail}',
  'confirm.refresh': 'Refreshing discards unsaved changes; continue?',
  'confirm.delete': 'Delete {path}? This cannot be undone.',
  'notice.saved': 'Global prompt saved',
  'notice.deleted': 'Global prompt deleted',
  'path.label': 'File path',
  'path.loading': 'Loading…',
  'path.unavailable': 'Path unavailable',
  'path.absent': 'The file does not exist yet; saving creates it.',
  'editor.label': 'Prompt body (Markdown)',
  'editor.placeholder': 'Write instructions that apply to every workspace here…',
  processing: 'Working…',
  create: 'Create',
  refresh: 'Refresh',
  'button.deleteFile': 'Delete file',
  'delete.dirtyTitle': 'Save or refresh the unsaved changes first',
  hint: 'Confirm the file path matches the global directory your agents use. Saving checks for external changes; on conflict, refresh and merge manually. New content takes effect on the next model step that has not started yet.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-prompts': PromptsKey
  }
}
