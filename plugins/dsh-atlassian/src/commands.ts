import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { COMMAND_CONF, COMMAND_JIRA } from './shared'

export type ParsedJiraLine =
  | { mode: 'issue'; key: string; instruction: string }
  | { mode: 'free'; query: string }
  | { mode: 'invalid'; reason: string }

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/

/** 首段是工单号形态 → 引用工单（余下为要做的事）；否则整行当自由请求。站点由配置自动关联。 */
export function parseJiraLine(raw: string): ParsedJiraLine {
  const line = raw.trim()
  if (line === '')
    return { mode: 'invalid', reason: '用法：/jira <工单号> [要做的事]，或 /jira <与 Jira 相关的请求>' }
  const match = /^(\S+)\s*([\s\S]*)$/.exec(line)
  const head = match?.[1] ?? ''
  const tail = (match?.[2] ?? '').trim()
  if (ISSUE_KEY_PATTERN.test(head)) return { mode: 'issue', key: head, instruction: tail }
  return { mode: 'free', query: line }
}

export type ParsedConfLine = { mode: 'ok'; query: string } | { mode: 'invalid'; reason: string }

export function parseConfLine(raw: string): ParsedConfLine {
  const query = raw.trim()
  if (query === '') return { mode: 'invalid', reason: '用法：/conf <主题或问题>' }
  return { mode: 'ok', query }
}

/** steer 文本面向模型：约定工具用法与多文档读取要求，结论让模型自己给。 */
export function jiraIssueSteerText(key: string, instruction: string): string {
  if (instruction === '') {
    return (
      `用户引用了 Jira 工单 ${key}。请先用 jira_get_issue 查询该工单内容，然后结合当前会话上下文` +
      `（若没有相关上下文，就仅基于工单内容）向用户概述工单要点，并询问用户下一步想做什么，给出可行的建议。`
    )
  }
  return (
    `用户要求处理 Jira 工单 ${key}，要求：${instruction}。` +
    `请先用 jira_get_issue 查询工单内容，再结合会话上下文执行该要求；` +
    `若工单内容与要求明显冲突，先向用户确认再动手。`
  )
}

export function jiraFreeSteerText(query: string): string {
  return (
    `用户提出了与 Jira 相关的请求：${query}。` +
    `请自行构造合适的 JQL 用 jira_search 检索（必要时多次调整查询条件），` +
    `把真正相关的工单都用 jira_get_issue 读取后再回答，不要只看第一条结果；` +
    `回答末尾列出实际用到的工单（KEY + 标题 + 链接）。` +
    `无法构造合理查询或结果为空时，向用户说明并追问澄清。`
  )
}

export function confSteerText(query: string): string {
  return (
    `请在 Confluence 中检索与下列主题相关的文档，并基于文档内容回答：` +
    `优先用 confluence_search 检索（命中的相关文档可能有多篇，按相关度把真正相关的都用 confluence_get_page 读取，不要只看第一篇）；` +
    `未找到相关文档时明确说明，不要编造内容；回答末尾列出实际用到的文档（标题 + 链接）。\n` +
    `主题：${query}`
  )
}

/** 命令 handler 不做任何网络调用：校验输入后 steer 一条用户消息；站点由配置自动关联。 */
export function registerCommands(ctx: Context): void {
  ctx.commands.register({
    name: COMMAND_JIRA,
    description: '引用 Jira 工单，或让 AI 检索、处理 Jira 事务',
    input: { hint: '<工单号> [要做的事] 或 <与 Jira 相关的请求>' },
    handler: ({ agent, rawInput }) => {
      const parsed = parseJiraLine(rawInput)
      if (parsed.mode === 'invalid') return { kind: 'error', text: parsed.reason }
      const text =
        parsed.mode === 'issue'
          ? jiraIssueSteerText(parsed.key, parsed.instruction)
          : jiraFreeSteerText(parsed.query)
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      return {
        kind: 'success',
        text:
          parsed.mode === 'issue'
            ? `已提交：AI 将查询工单 ${parsed.key}${parsed.instruction === '' ? '并向你确认下一步' : '并按要求处理'}。`
            : '已提交：AI 将检索 Jira 后处理你的请求。',
      }
    },
  })
  ctx.commands.register({
    name: COMMAND_CONF,
    description: '在 Confluence 知识库中检索文档并基于文档回答',
    input: { hint: '<主题或问题>' },
    handler: ({ agent, rawInput }) => {
      const parsed = parseConfLine(rawInput)
      if (parsed.mode === 'invalid') return { kind: 'error', text: parsed.reason }
      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text: confSteerText(parsed.query) }],
          source: { kind: 'user' },
        }),
      )
      return { kind: 'success', text: '已提交：AI 将检索 Confluence 文档后回答。' }
    },
  })
}
