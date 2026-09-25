import { describe, expect, it } from 'vitest'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
// 官方载荷类型：畸形 fixture 用 as unknown as 显式模拟「宿主运行时与编译时
// 类型声明存在版本偏差」的场景——生产代码对这些输入保持防御性回退。
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { questionDetail, approvalDetail, interactionDetail } from '../src/client'
describe('questionDetail', () => {
	it('单题取问题文本并去除首尾空白', () => {
		expect(questionDetail([{ id: 'q1', question: '  用哪个端口？  ' }])).toBe('用哪个端口？')
	})

	it('多题汇总数量', () => {
		expect(
			questionDetail([
				{ id: 'q1', question: '用哪个端口？' },
				{ id: 'q2', question: '要保留旧配置吗？' },
			]),
		).toBe('用哪个端口？ 等 2 个问题')
	})

	it('plan-review 意图标注等待计划审批', () => {
		expect(
			questionDetail([
				{ id: 'plan', question: '计划如下……', intent: { kind: 'plan-review', approve: '批准' } },
			]),
		).toBe('等待计划审批')
	})

	it('超长文本截断到 120 字符加省略号', () => {
		expect(questionDetail([{ id: 'q1', question: 'a'.repeat(200) }])).toBe('a'.repeat(120) + '…')
	})

	it('空列表、缺失或非法文本回退通用文案', () => {
		expect(questionDetail([])).toBe('等待您的回答')
		expect(questionDetail(undefined)).toBe('等待您的回答')
		expect(questionDetail([{ id: 'q1' } as unknown as AskUserQuestionItem])).toBe('等待您的回答')
		expect(questionDetail([{ id: 'q1', question: 42 } as unknown as AskUserQuestionItem])).toBe(
			'等待您的回答',
		)
	})

	it('多题中无文本项也计入总数', () => {
		expect(
			questionDetail([
				{ id: 'q1', question: '用哪个端口？' },
				{ id: 'q2' } as unknown as AskUserQuestionItem,
			]),
		).toBe('用哪个端口？ 等 2 个问题')
	})
})

describe('approvalDetail', () => {
	it('有工具名无原因', () => {
		expect(approvalDetail('bash', undefined)).toBe('等待批准：bash')
	})

	it('工具名 + 原因', () => {
		expect(approvalDetail('bash', '允许执行 pnpm test 吗？')).toBe('等待批准：bash · 允许执行 pnpm test 吗？')
	})

	it('超长原因截断到 120 字符加省略号', () => {
		expect(approvalDetail('write', 'a'.repeat(200))).toBe('等待批准：write · ' + 'a'.repeat(120) + '…')
	})

	it('非法或空白工具名回退「工具」', () => {
		expect(approvalDetail(undefined as unknown as string, 'r')).toBe('等待批准：工具 · r')
		expect(approvalDetail('   ', 'r')).toBe('等待批准：工具 · r')
	})

	it('非法或空白原因不追加', () => {
		expect(approvalDetail('bash', 42 as unknown as string)).toBe('等待批准：bash')
		expect(approvalDetail('bash', '   ')).toBe('等待批准：bash')
	})
})

describe('interactionDetail', () => {
	const interaction = (fields: Record<string, unknown>): SessionPendingInteractionBase =>
		fields as unknown as SessionPendingInteractionBase

	it('question 域取问题文本', () => {
		expect(
			interactionDetail(
				interaction({
					key: 'question:1',
					kind: 'question',
					sessionId: 's1',
					questions: [{ id: 'q1', question: '用哪个端口？' }],
				}),
			),
		).toBe('用哪个端口？')
	})

	it('plan-review 域直接标注等待计划审批', () => {
		expect(interactionDetail(interaction({ key: 'question:2', kind: 'plan-review', sessionId: 's1' }))).toBe(
			'等待计划审批',
		)
	})

	it('approval 域取工具名 + 原因', () => {
		expect(
			interactionDetail(
				interaction({
					key: 'approval:1',
					kind: 'approval',
					sessionId: 's1',
					toolName: 'bash',
					reason: '允许执行 pnpm test 吗？',
				}),
			),
		).toBe('等待批准：bash · 允许执行 pnpm test 吗？')
	})

	it('未知域与缺失字段回退通用文案', () => {
		expect(interactionDetail(interaction({ key: 'x:1', kind: 'other', sessionId: 's1' }))).toBe(
			'等待您的回答',
		)
		expect(interactionDetail(interaction({ key: 'a:1', kind: 'approval', sessionId: 's1' }))).toBe(
			'等待批准：工具',
		)
	})
})
