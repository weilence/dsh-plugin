// 独立成模块让单测不把 React / CSS 拖进 Node 路径。

import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

export function questionDetail(questions: readonly AskUserQuestionItem[] | undefined): string {
  const list = Array.isArray(questions) ? questions : []
  const texts: string[] = []
  for (const item of list) {
    if (item == null || typeof item !== 'object') continue
    if (item.intent?.kind === 'plan-review') {
      texts.push('等待计划审批')
      continue
    }
    const text = item.question
    if (typeof text === 'string' && text.trim().length > 0) texts.push(text.trim())
  }
  if (texts.length === 0) return '等待您的回答'
  const first = texts[0].length > 120 ? texts[0].slice(0, 120) + '…' : texts[0]
  return list.length > 1 ? `${first} 等 ${list.length} 个问题` : first
}

export function approvalDetail(toolName: string | undefined, reason: string | undefined): string {
  const tool = typeof toolName === 'string' && toolName.trim().length > 0 ? toolName.trim() : '工具'
  const base = `等待批准：${tool}`
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (text.length === 0) return base
  return `${base} · ${text.length > 120 ? text.slice(0, 120) + '…' : text}`
}

// PendingQuestion / PendingApproval 由官方 UI 包声明合并，本包按 Base 类型
// 收参、结构化取字段，保持零额外依赖与版本容差。
export function interactionDetail(interaction: SessionPendingInteractionBase): string {
  const extra = interaction as SessionPendingInteractionBase & {
    readonly questions?: unknown
    readonly toolName?: unknown
    readonly reason?: unknown
  }
  if (interaction.kind === 'plan-review') return '等待计划审批'
  if (interaction.kind === 'approval') {
    return approvalDetail(extra.toolName as string | undefined, extra.reason as string | undefined)
  }
  return questionDetail(extra.questions as readonly AskUserQuestionItem[] | undefined)
}
