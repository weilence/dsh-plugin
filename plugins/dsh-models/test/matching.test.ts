import { describe, expect, it } from 'vitest'
import { discoveredToCatalogEntry, findModelMetadata } from '../src/catalog/matching'
import type { ModelsDevCatalog, ModelsDevModel, ModelsDevProvider } from '../src/catalog/types'

function model(id: string, name = id, patch: Partial<ModelsDevModel> = {}): ModelsDevModel {
	return {
		id,
		name,
		reasoning: true,
		reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
		toolCall: true,
		modalities: { input: ['text', 'image'], output: ['text'] },
		limit: { context: 128000, output: 8192 },
		...patch,
	}
}

function provider(id: string, name = id, models: ModelsDevModel[] = []): ModelsDevProvider {
	return { id, name, env: [], models }
}

function catalog(providers: ModelsDevProvider[]): ModelsDevCatalog {
	return {
		providers,
		providerById: new Map(providers.map((item) => [item.id, item])),
		etag: null,
		checkedAt: null,
		updatedAt: null,
	}
}

describe('model family metadata provider matching', () => {
	const directory = catalog([
		provider('openai', 'OpenAI'),
		provider('anthropic', 'Anthropic'),
		provider('z-ai', 'Z.AI'),
		provider('deepseek', 'DeepSeek'),
		provider('google', 'Google'),
		provider('alibaba', 'Alibaba Cloud'),
		provider('moonshotai', 'Moonshot AI'),
		provider('volcengine', 'Volcengine'),
		provider('minimax', 'MiniMax'),
		provider('xai', 'xAI'),
		provider('mistral', 'Mistral'),
		provider('cohere', 'Cohere'),
		provider('baidu', 'Baidu'),
		provider('tencent', 'Tencent Cloud'),
		provider('stepfun', 'StepFun'),
	])

	it.each([
		['gpt-5', 'openai'],
		['o3-mini', 'openai'],
		['claude-sonnet-4', 'anthropic'],
		['glm-4.5', 'z-ai'],
		['deepseek-chat', 'deepseek'],
		['gemini-2.5-pro', 'google'],
		['qwen3-max', 'alibaba'],
		['kimi-k2', 'moonshotai'],
		['doubao-pro', 'volcengine'],
		['minimax-m2', 'minimax'],
		['grok-3', 'xai'],
		['codestral-25.01', 'mistral'],
		['command-r', 'cohere'],
		['ernie-4.5', 'baidu'],
		['hunyuan-t1', 'tencent'],
		['step-2', 'stepfun'],
	])('prefers %s metadata from %s via the preference table', (id, providerId) => {
		// 偏好表现在只经 findModelMetadata 的 ② 层消费：把模型放进其厂商目录，
		// 前缀定位应命中同一家厂商；路由错位会让精确匹配落空。
		const source = provider(providerId, providerId, [model(id)])
		expect(findModelMetadata(catalog([source]), id)?.provider.id).toBe(providerId)
	})

	it('does not treat open-weight GPT-OSS or unrelated IDs as OpenAI API models', () => {
		expect(findModelMetadata(directory, 'gpt-oss-120b', 'openai')).toBeUndefined()
		expect(findModelMetadata(directory, 'my-gpt-model', 'openai')).toBeUndefined()
	})

	it('requires an exact model ID and uses the endpoint source before the publisher', () => {
		const source = provider('gateway', 'Gateway', [
			model('claude-sonnet-4', 'Gateway alias', { limit: { context: 32000, output: 1000 } }),
		])
		const anthropic = provider('anthropic', 'Anthropic', [
			model('claude-sonnet-4', 'Claude Sonnet 4', { limit: { context: 200000, output: 64000 } }),
		])
		const current = catalog([
			...directory.providers.filter((item) => item.id !== 'anthropic'),
			source,
			anthropic,
		])

		// Endpoint Provider 命中优先：ID 完全相等时不再看厂商目录。
		expect(findModelMetadata(current, 'claude-sonnet-4', 'gateway')?.provider.id).toBe('gateway')
		const entry = discoveredToCatalogEntry(
			current,
			{ id: 'claude-sonnet-4', name: 'Endpoint name', contextWindow: 555000, maxTokens: 666 },
			'gateway',
		)
		expect(entry).toMatchObject({
			id: 'claude-sonnet-4',
			name: 'Gateway alias',
			contextWindow: 32000,
			maxTokens: 1000,
			input: ['text', 'image'],
		})
	})

	it('removes a trailing -suffix for metadata only, preferring the longest known model ID', () => {
		const openai = provider('openai', 'OpenAI', [
			model('gpt-5', 'GPT 5', { limit: { context: 100000, output: 1000 } }),
			model('gpt-5-mini', 'GPT 5 Mini', { limit: { context: 200000, output: 2000 } }),
		])
		const gateway = provider('gateway', 'Gateway', [
			model('gpt-5-mini', 'Gateway GPT', { limit: { context: 300000, output: 3000 } }),
		])
		const current = catalog([openai, gateway])
		const entry = discoveredToCatalogEntry(current, { id: 'gpt-5-mini-xxxx' }, 'gateway')
		expect(findModelMetadata(current, 'gpt-5-mini-xxxx', 'gateway')).toMatchObject({
			provider: { id: 'openai' },
			model: { id: 'gpt-5-mini' },
		})
		expect(entry).toMatchObject({ id: 'gpt-5-mini-xxxx', name: 'GPT 5 Mini', contextWindow: 200000 })
		expect(findModelMetadata(current, 'gpt-50-xxxx', 'gateway')).toBeUndefined()
		expect(findModelMetadata(current, 'prefix-gpt-5-mini-xxxx', 'gateway')).toBeUndefined()
	})

	it('prefers an exact model ID over its shorter suffixed candidate', () => {
		const current = catalog([provider('zai', 'Z.AI', [model('glm-4.5'), model('glm-4.5-xxxx')])])
		expect(findModelMetadata(current, 'glm-4.5-xxxx')?.model.id).toBe('glm-4.5-xxxx')
	})

	it('does not extend endpoint-provider matching to suffixed IDs', () => {
		const current = catalog([
			provider('openai', 'OpenAI'),
			provider('gateway', 'Gateway', [model('gpt-5', 'Gateway GPT')]),
		])
		// Endpoint Provider 只认 ID 完全相等；-尾缀交给厂商推断，而厂商目录
		// （openai）里没有可匹配的模型，整体不匹配。
		expect(findModelMetadata(current, 'gpt-5-xxxx', 'gateway')).toBeUndefined()
		expect(findModelMetadata(current, 'gpt-5-xxxx')).toBeUndefined()
	})

	it('falls back to the endpoint provider only for a matching ID, and preserves discovery facts otherwise', () => {
		const gateway = provider('gateway', 'Gateway', [model('gpt-new', 'Gateway GPT')])
		const current = catalog([...directory.providers, gateway])
		expect(findModelMetadata(current, 'gpt-new', 'gateway')?.provider.id).toBe('gateway')
		expect(findModelMetadata(current, 'gpt-new', 'missing')).toBeUndefined()
		expect(discoveredToCatalogEntry(current, { id: 'unknown', name: 'Unknown', contextWindow: 777 })).toEqual(
			{
				id: 'unknown',
				name: 'Unknown',
				contextWindow: 777,
			},
		)
	})

	it('recovers an exact ID the publisher lacks via the cross-catalog fallback', () => {
		const official = provider('deepseek', 'DeepSeek', [model('deepseek-v4-flash')])
		const thirdParty = provider('gateway-a', 'Gateway A', [
			model('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', { limit: { context: 1000000, output: 384000 } }),
		])
		const current = catalog([official, thirdParty])
		expect(findModelMetadata(current, 'deepseek-v4.1-flash', 'deepseek')).toBeUndefined()
		expect(discoveredToCatalogEntry(current, { id: 'deepseek-v4.1-flash' })).toMatchObject({
			id: 'deepseek-v4.1-flash',
			name: 'DeepSeek V4.1 Flash',
			contextWindow: 1000000,
			maxTokens: 384000,
		})
	})

	it('matches a dated snapshot suffix across the catalog and votes the majority capacity', () => {
		const official = provider('deepseek', 'DeepSeek', [model('deepseek-v4-flash')])
		const a = provider('gateway-a', 'A', [
			model('deepseek-v4.1-flash', 'DS41', { limit: { context: 1000000, output: 384000 } }),
		])
		const b = provider('gateway-b', 'B', [
			model('deepseek-v4.1-flash', 'DS41', { limit: { context: 1000000, output: 384000 } }),
		])
		const c = provider('gateway-c', 'C', [
			model('deepseek-v4.1-flash', 'DS41', { limit: { context: 1048576, output: 393216 } }),
		])
		const current = catalog([official, a, b, c])
		// ② 厂商目录（deepseek 官方）没有 v4.1 基础 ID → ③ 跨目录尾缀命中，
		// 三家取多数派 (1000000, 384000)。
		expect(discoveredToCatalogEntry(current, { id: 'deepseek-v4.1-flash-0910' })).toMatchObject({
			id: 'deepseek-v4.1-flash-0910',
			name: 'DS41',
			contextWindow: 1000000,
			maxTokens: 384000,
		})
	})

	it('breaks capacity-vote ties toward the larger limit', () => {
		const a = provider('gateway-a', 'A', [
			model('fam-model', 'Fam', { limit: { context: 1000000, output: 8192 } }),
		])
		const b = provider('gateway-b', 'B', [
			model('fam-model', 'Fam', { limit: { context: 2000000, output: 8192 } }),
		])
		const current = catalog([a, b])
		expect(discoveredToCatalogEntry(current, { id: 'fam-model-0901' })?.contextWindow).toBe(2000000)
	})

	it('still prefers the longest cross-catalog family ID for suffixes', () => {
		const a = provider('gateway-a', 'A', [
			model('fam-model', 'Base', { limit: { context: 1000, output: 100 } }),
			model('fam-model-fast', 'Fast', { limit: { context: 2000, output: 200 } }),
		])
		const current = catalog([a])
		expect(discoveredToCatalogEntry(current, { id: 'fam-model-fast-0901' })).toMatchObject({
			contextWindow: 2000,
			maxTokens: 200,
			name: 'Fast',
		})
	})

	it('keeps publisher metadata ahead of the cross-catalog fallback', () => {
		const official = provider('deepseek', 'DeepSeek', [
			model('deepseek-v4-flash', 'Official V4', { limit: { context: 1000000, output: 393216 } }),
		])
		const gateway = provider('gateway', 'Gateway', [
			model('deepseek-v4-flash', 'Gateway V4', { limit: { context: 123456, output: 789 } }),
		])
		const current = catalog([gateway, official])
		expect(discoveredToCatalogEntry(current, { id: 'deepseek-v4-flash' })).toMatchObject({
			name: 'Official V4',
			contextWindow: 1000000,
			maxTokens: 393216,
		})
	})
})
