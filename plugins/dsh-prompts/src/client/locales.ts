import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的词典命名空间：注册进宿主 locale 服务，语言选择与回退由其统一裁决。 */
export const NS = 'dsh-prompts'

export type PromptsT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  'section.label': '系统提示词',
  title: '系统提示词',
  subtitle: '编辑追加到系统提示词末尾的用户段，对所有工作区生效；AGENTS.md 等指令文件不受影响。',
  'load.failed': '读取系统提示词失败：{detail}',
  'save.failed': '保存失败：{detail}',
  'notice.saved': '系统提示词已保存',
  'editor.label': '提示词正文（Markdown）',
  'editor.placeholder': '在此编写随系统提示词发送给模型的指令…',
  processing: '处理中…',
  create: '创建',
} as const

export type PromptsKey = keyof typeof zh

export const en: { [Key in PromptsKey]: string } = {
  'section.label': 'System prompt',
  title: 'System prompt',
  subtitle:
    'Edit the user section appended to the end of the system prompt; it applies to every workspace and leaves AGENTS.md instruction files untouched.',
  'load.failed': 'Reading the system prompt failed: {detail}',
  'save.failed': 'Saving failed: {detail}',
  'notice.saved': 'System prompt saved',
  'editor.label': 'Prompt body (Markdown)',
  'editor.placeholder': 'Write instructions sent to the model with the system prompt here…',
  processing: 'Working…',
  create: 'Create',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-prompts': PromptsKey
  }
}
