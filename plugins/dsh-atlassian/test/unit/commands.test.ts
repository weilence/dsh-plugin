import { describe, expect, it } from 'vitest'
import {
  confSteerText,
  jiraFreeSteerText,
  jiraIssueSteerText,
  parseConfLine,
  parseJiraLine,
} from '../../src/commands'

describe('parseJiraLine', () => {
  it('空输入 → invalid', () => {
    expect(parseJiraLine('  ').mode).toBe('invalid')
    expect(parseJiraLine('').mode).toBe('invalid')
  })

  it('工单号裸引用 → issue 无指令', () => {
    const parsed = parseJiraLine('PROJ-123')
    expect(parsed).toEqual({ mode: 'issue', key: 'PROJ-123', instruction: '' })
  })

  it('工单号 + 指令 → issue 带指令', () => {
    const parsed = parseJiraLine('  PROJ-1   修复登录 bug 并提交  ')
    expect(parsed).toEqual({ mode: 'issue', key: 'PROJ-1', instruction: '修复登录 bug 并提交' })
  })

  it('首段非工单号形态 → 自由请求（整行）', () => {
    expect(parseJiraLine('这个迭代还有哪些没完成')).toEqual({ mode: 'free', query: '这个迭代还有哪些没完成' })
    expect(parseJiraLine('proj-123 修复它')).toEqual({ mode: 'free', query: 'proj-123 修复它' })
  })

  it('工单号形态要求大写开头数字段', () => {
    expect(parseJiraLine('ABC1-9 x')).toEqual({ mode: 'issue', key: 'ABC1-9', instruction: 'x' })
    expect(parseJiraLine('AB_C-9 x').mode).toBe('free')
  })
})

describe('parseConfLine', () => {
  it('非空 → ok', () => {
    expect(parseConfLine(' 部署流程 ')).toEqual({ mode: 'ok', query: '部署流程' })
  })

  it('空 → invalid', () => {
    expect(parseConfLine('  ').mode).toBe('invalid')
  })
})

describe('steer 文本', () => {
  it('裸引用要求查询并询问下一步', () => {
    const text = jiraIssueSteerText('PROJ-123', '')
    expect(text).toContain('jira_get_issue')
    expect(text).toContain('PROJ-123')
    expect(text).toContain('询问用户下一步')
    expect(text).not.toContain('site 参数')
  })

  it('带指令要求先查询再执行', () => {
    const text = jiraIssueSteerText('PROJ-123', '修复登录 bug')
    expect(text).toContain('修复登录 bug')
    expect(text).toContain('先向用户确认')
  })

  it('自由请求要求自行构造 JQL 并全部读取', () => {
    const text = jiraFreeSteerText('迭代剩余工作')
    expect(text).toContain('jira_search')
    expect(text).toContain('jira_get_issue')
    expect(text).toContain('迭代剩余工作')
    expect(text).toContain('KEY + 标题 + 链接')
  })

  it('conf 要求多文档检索并引用清单', () => {
    const text = confSteerText('部署流程')
    expect(text).toContain('confluence_search')
    expect(text).toContain('confluence_get_page')
    expect(text).toContain('不要只看第一篇')
    expect(text).toContain('部署流程')
  })
})
