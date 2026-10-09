import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的词典命名空间：注册进宿主 locale 服务，语言选择与回退由其统一裁决。 */
export const NS = 'dsh-prompts'

export type PromptsT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  'section.label': '系统提示词',
  title: '系统提示词',
  subtitle: '编辑追加到系统提示词末尾的用户段；对所有工作区生效，AGENTS.md 等指令文件不受影响。',
  'load.failed': '读取系统提示词失败：{detail}',
  'save.failed': '保存失败：{detail}',
  'delete.failed': '删除失败：{detail}',
  'confirm.refresh': '刷新会丢弃尚未保存的修改，确定继续吗？',
  'confirm.delete': '确定删除 {path} 吗？此操作不可撤销。',
  'notice.saved': '系统提示词已保存',
  'notice.deleted': '系统提示词已删除',
  'path.label': '文件路径',
  'path.loading': '读取中…',
  'path.unavailable': '路径不可用',
  'path.absent': '文件尚不存在，保存后将创建。',
  'editor.label': '提示词正文（Markdown）',
  'editor.placeholder': '在此编写随系统提示词发送给模型的指令…',
  processing: '处理中…',
  create: '创建',
  refresh: '刷新',
  'button.deleteFile': '删除文件',
  'delete.dirtyTitle': '请先保存或刷新未保存的修改',
  hint: '内容作为独立段落拼接进系统提示词末尾，与宿主内置内容互不干扰；下一次尚未开始的模型步骤生效。保存时会检查外部修改；若有冲突，请刷新并自行合并。',
} as const

export type PromptsKey = keyof typeof zh

export const en: { [Key in PromptsKey]: string } = {
  'section.label': 'System prompt',
  title: 'System prompt',
  subtitle:
    'Edit the user section appended to the end of the system prompt; it applies to every workspace and leaves AGENTS.md instruction files untouched.',
  'load.failed': 'Reading the system prompt failed: {detail}',
  'save.failed': 'Saving failed: {detail}',
  'delete.failed': 'Deleting failed: {detail}',
  'confirm.refresh': 'Refreshing discards unsaved changes; continue?',
  'confirm.delete': 'Delete {path}? This cannot be undone.',
  'notice.saved': 'System prompt saved',
  'notice.deleted': 'System prompt deleted',
  'path.label': 'File path',
  'path.loading': 'Loading…',
  'path.unavailable': 'Path unavailable',
  'path.absent': 'The file does not exist yet; saving creates it.',
  'editor.label': 'Prompt body (Markdown)',
  'editor.placeholder': 'Write instructions sent to the model with the system prompt here…',
  processing: 'Working…',
  create: 'Create',
  refresh: 'Refresh',
  'button.deleteFile': 'Delete file',
  'delete.dirtyTitle': 'Save or refresh the unsaved changes first',
  hint: 'The content is appended to the end of the system prompt as its own section, independent of the built-in content, and takes effect on the next model step that has not started yet. Saving checks for external changes; on conflict, refresh and merge manually.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-prompts': PromptsKey
  }
}
