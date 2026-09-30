// 独立成模块让单测不把 React / CSS 拖进 Node 路径。

import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { NotifyT } from './client/locales'

export function questionDetail(t: NotifyT, questions: readonly AskUserQuestionItem[] | undefined): string {
  const list = Array.isArray(questions) ? questions : []
  const texts: string[] = []
  for (const item of list) {
    if (item == null || typeof item !== 'object') continue
    if (item.intent?.kind === 'plan-review') {
      texts.push(t('detail.planReview'))
      continue
    }
    const text = item.question
    if (typeof text === 'string' && text.trim().length > 0) texts.push(text.trim())
  }
  if (texts.length === 0) return t('detail.questionFallback')
  const first = texts[0].length > 120 ? texts[0].slice(0, 120) + '…' : texts[0]
  return list.length > 1 ? t('detail.questionCount', { first, count: list.length }) : first
}

export function approvalDetail(t: NotifyT, toolName: string | undefined, reason: string | undefined): string {
  const name = typeof toolName === 'string' && toolName.trim().length > 0 ? toolName.trim() : t('detail.tool')
  const base = t('detail.approval', { tool: name })
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (text.length === 0) return base
  return t('detail.approvalSuffix', { base, reason: text.length > 120 ? text.slice(0, 120) + '…' : text })
}

// PendingQuestion / PendingApproval 由官方 UI 包声明合并，本包按 Base 类型
// 收参、结构化取字段，保持零额外依赖与版本容差。
export function interactionDetail(t: NotifyT, interaction: SessionPendingInteractionBase): string {
  const extra = interaction as SessionPendingInteractionBase & {
    readonly questions?: unknown
    readonly toolName?: unknown
    readonly reason?: unknown
  }
  if (interaction.kind === 'plan-review') return t('detail.planReview')
  if (interaction.kind === 'approval') {
    return approvalDetail(t, extra.toolName as string | undefined, extra.reason as string | undefined)
  }
  return questionDetail(t, extra.questions as readonly AskUserQuestionItem[] | undefined)
}
