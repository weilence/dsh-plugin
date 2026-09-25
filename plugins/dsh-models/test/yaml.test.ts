import { describe, expect, it } from 'vitest'
import { Document, parseDocument } from 'yaml'
import { toRoutePreview, toYamlPreview, writePathOf } from '../src/pi-ai/yaml'
import { saveModelProfile, materializeWithNewModel, planAddModel } from '../src/pi-ai/profile'

describe('预览 YAML 与官方写盘同风格', () => {
	it('渲染结果 = 官方 Document#toString()（新文件路径）', () => {
		const section = {
			providers: {
				'zai-coding-cn': {
					apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
					models: [{ id: 'glm-5.3', reasoningEfforts: { off: null, low: 'low', high: 'high' } }],
				},
			},
		}
		// 官方 dsh-settings-file 的全新写入：new Document({ [ns]: section }).toString()
		const official = new Document({ 'llm-pi-ai': section }).toString()
		expect(toYamlPreview({ 'llm-pi-ai': section })).toBe(official)
	})

	it('route 预览可被 YAML 解析回同一份 JSON 对象', () => {
		const profile = {
			modelOverrides: { alpha: { id: 'alpha', reasoningEfforts: { off: null, low: 'low' } } },
		}
		const text = toRoutePreview('anthropic', profile)
		const body = text
			.split('\n')
			.filter((line) => !line.startsWith('#'))
			.join('\n')
		const parsed = parseDocument(body).toJS() as { providers: Record<string, unknown> }
		expect(parsed.providers['anthropic']).toEqual(profile)
	})

	it('旧写法 off: 与新写法 off: null 解析结果相同（预览展示的是新写入形态）', () => {
		const original = parseDocument('reasoningEfforts:\n  off:\n  high: high\n').toJS()
		const previewed = parseDocument('reasoningEfforts:\n  off: null\n  high: high\n').toJS()
		expect(previewed).toEqual(original)
	})

	it('需要引号的值被正确转义，不会产出非法 YAML', () => {
		const profile = { name: 'true', baseURL: 'https://g/v1?x=1&y=2', note: '# 注释样文本' }
		const text = toRoutePreview('gw', profile)
		const body = text
			.split('\n')
			.filter((line) => !line.startsWith('#'))
			.join('\n')
		const parsed = parseDocument(body).toJS() as { providers: Record<string, unknown> }
		expect(parsed.providers['gw']).toEqual(profile)
	})
})

describe('预览与写入共用同一条规划路径', () => {
	const catalog = new Map([
		['alpha', { name: 'Alpha', contextWindow: 1000, maxTokens: 100 }],
		['beta', { name: 'Beta' }],
	])
	const row = {
		id: 'alpha',
		name: 'Alpha',
		userEntry: undefined,
		catalogEntry: { id: 'alpha', contextWindow: 1000 },

		writeSite: 'catalog' as const,
	}

	it('目录 route 编辑既有模型 → 预览显示 modelOverrides', () => {
		const profile = saveModelProfile('inherited', undefined, row, { id: 'alpha', maxTokens: 7 })
		expect(toRoutePreview('anthropic', profile)).toContain('modelOverrides:')
		expect(toRoutePreview('anthropic', profile)).not.toContain('models:')
	})

	it('新增目录未描述模型 → 预览显示物化后的完整 models 清单', () => {
		const plan = planAddModel({
			source: 'inherited',
			userProfile: undefined,
			catalog,
			entry: { id: 'gamma' },
		})
		expect(plan.kind).toBe('materialize')
		if (plan.kind !== 'materialize') return
		const text = toRoutePreview('anthropic', plan.profile)
		expect(text).toContain('models:')
		expect(text).toContain('id: alpha')
		expect(text).toContain('id: beta')
		expect(text).toContain('id: gamma')
	})

	it('目录读不到时不给出预览，而是 blocked 原因（与写入一致）', () => {
		const plan = planAddModel({
			source: 'inherited',
			userProfile: undefined,
			catalog: new Map(),
			entry: { id: 'x' },
		})
		expect(plan).toEqual({ kind: 'blocked', reason: expect.stringContaining('无法读取') })
	})

	it('materializeWithNewModel 与 planAddModel 输出一致', () => {
		const direct = materializeWithNewModel(undefined, catalog, { id: 'gamma' })
		const planned = planAddModel({
			source: 'inherited',
			userProfile: undefined,
			catalog,
			entry: { id: 'gamma' },
		})
		expect(planned.kind === 'materialize' ? planned.profile : null).toEqual(direct)
	})
})

describe('YAML 边角形态与官方完全一致（预览可直接复制进 settings.yaml）', () => {
	const cases: Array<[string, unknown]> = [
		['多行字符串', { note: 'line1\nline2\n' }],
		['需要引号的标量', { name: 'true', label: 'a: b "c"', hash: '# 注释' }],
		['空对象与空数组', { compat: {}, models: [] }],
		['中文与 URL', { displayName: '智谱 Coding Plan', baseURL: 'https://g/v1?x=1&y=2' }],
		['推理强度', { reasoningEfforts: { off: null, low: 'low', high: 'high' } }],
	]
	for (const [name, profile] of cases) {
		it(`渲染 ${name}`, () => {
			const text = toRoutePreview('p', profile)
			const body = text
				.split('\n')
				.filter((line) => !line.startsWith('#'))
				.join('\n')
			expect(parseDocument(body).toJS()).toEqual({ providers: { p: profile } })
			// 与官方 Document 的字节级一致（去掉位置注释后再拼回单个 Document）
			expect(parseDocument(body).toString()).toBe(new Document({ providers: { p: profile } }).toString())
		})
	}
})

describe('写入路径判断（用于预览说明）', () => {
	it('显式清单 → models；目录覆盖 → modelOverrides', () => {
		expect(writePathOf({ models: [{ id: 'a' }] })).toBe('models')
		expect(writePathOf({ modelOverrides: { a: { id: 'a' } } })).toBe('modelOverrides')
		expect(writePathOf({ apiKeyEnv: 'K' })).toBe('empty')
		// 物化时 modelOverrides 必须已被清掉，否则官方会拒绝（二者互斥）。
		expect(writePathOf({ models: [{ id: 'a' }], modelOverrides: undefined })).toBe('models')
	})
})
