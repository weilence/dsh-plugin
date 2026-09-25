import { describe, expect, it, vi } from 'vitest'
import { PanelStore, type ConfigFormLike, type StoreContext } from '../src/client/store'
import { readChoices } from '../src/pi-ai/choices'
import type { PiAiOperations, RouteDirectoryRow } from '../src/client/operations'

/** 一个可控的 configForms 共享表单替身（镜像快照）。 */
function scopeStub(initial: { user?: unknown; value?: unknown; revision?: number; writable?: boolean }) {
	let snapshot = {
		status: 'ready' as const,
		value: initial.value ?? {},
		user: initial.user ?? {},
		base: {},
		revision: initial.revision ?? 1,
		writable: initial.writable ?? true,
		mode: 'host' as const,
	}
	const listeners = new Set<() => void>()
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		/** 模拟一次外部 settings 变更。 */
		push(next: Partial<typeof snapshot>) {
			snapshot = { ...snapshot, ...next }
			for (const listener of listeners) listener()
		},
	}
}

/** 只提供 store 需要的两个方法的 operations 替身。 */
function operationsStub(overrides: Partial<PiAiOperations> = {}) {
	const directory: RouteDirectoryRow[] = [
		{ provider: 'anthropic', displayName: 'Anthropic', declared: false, active: true },
	]
	type WriteProfile = PiAiOperations['writeProfile']
	type DeleteProfile = PiAiOperations['deleteProfile']
	const writeProfile = vi.fn<WriteProfile>(async () => ({ kind: 'written' }))
	const deleteProfile = vi.fn<DeleteProfile>(async () => ({ kind: 'written' }))
	const operations: PiAiOperations = {
		loadDirectory: async () => directory,
		discover: async () => [{ id: 'claude-x', name: 'Claude X', contextWindow: 1000, maxTokens: 100 }],
		discoverEndpoint: async () => [{ id: 'claude-x', name: 'Claude X', contextWindow: 1000, maxTokens: 100 }],
		effective: async () => ({ kind: 'found', models: [{ id: 'claude-x', name: 'Claude X' }] }),
		writeProfile,
		deleteProfile,
		describeCredential: async () => undefined,
		storeCredential: async () => undefined,
		...overrides,
	}
	return { operations, writeProfile, deleteProfile }
}

function contextStub() {
	const handlers = new Map<string, Set<() => void>>()
	const ctx: StoreContext = {
		remote: { $on: () => () => {} },
		on(name, listener) {
			const set = handlers.get(name) ?? new Set()
			set.add(listener)
			handlers.set(name, set)
		},
		off(name, listener) {
			handlers.get(name)?.delete(listener)
		},
	}
	return ctx
}

function storeOf(options: { scope: ConfigFormLike; operations: PiAiOperations }) {
	const ctx = contextStub()
	const store = new PanelStore({
		ctx,
		operations: options.operations,
		scope: options.scope,
		getChoices: () => readChoices(undefined),
	})
	return { ctx, store }
}

describe('模型目录面板 store', () => {
	it('刷新后给出「目录继承」行，并带上生效能力', async () => {
		const scope = scopeStub({
			user: { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } },
			value: { providers: { anthropic: { displayName: 'Anthropic' } } },
		})
		const { operations } = operationsStub()
		const { store } = storeOf({ scope, operations })
		await store.refresh()
		const state = store.getSnapshot()
		expect(state.status).toBe('ready')
		expect(state.routes).toHaveLength(1)
		expect(state.routes[0]?.source).toBe('inherited')
		expect(state.routes[0]?.rows[0]?.id).toBe('claude-x')
		expect(state.routes[0]?.rows[0]?.facts?.name).toBe('Claude X')
	})

	it('未配置的内置 provider 不触发 discoverModels（面板从不展示它们的模型清单）', async () => {
		const scope = scopeStub({ user: {}, value: {} })
		const base = operationsStub()
		const discoverSpy = vi.fn(async () => [{ id: 'claude-x', name: 'Claude X' }])
		const operations = { ...base.operations, discover: discoverSpy }
		const { store } = storeOf({ scope, operations })
		await store.refresh()
		expect(discoverSpy).not.toHaveBeenCalled()
		// 休眠 route 仍在目录里（供新建下拉使用），只是没有模型清单。
		expect(store.getSnapshot().routes[0]?.configured).toBe(false)
		expect(store.getSnapshot().routes[0]?.rows).toHaveLength(0)
	})

	it('并发 refresh 触发合并为一次加载，而不是逐个排队', async () => {
		const scope = scopeStub({
			user: {},
			value: { providers: { anthropic: {} } },
		})
		const base = operationsStub()
		const loadDirectory = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5))
			return base.operations.loadDirectory()
		})
		const operations = { ...base.operations, loadDirectory }
		const { store } = storeOf({ scope, operations })
		void store.refresh()
		void store.refresh()
		void store.refresh()
		await store.refresh()
		// 三次并发触发 + 最终 await：合并为一次（等待中的那次不算新加载）。
		expect(loadDirectory).toHaveBeenCalledTimes(1)
	})

	it('凭据 describe 按引用缓存，同一引用重复查询只请求一次', async () => {
		const scope = scopeStub({ user: {}, value: { providers: { anthropic: {} } } })
		const base = operationsStub()
		const describeCredential = vi.fn(async () => ({ ref: 'ANTHROPIC_API_KEY', configured: true }))
		const operations = { ...base.operations, describeCredential }
		const { store } = storeOf({ scope, operations })
		await store.refresh()
		const first = await store.credentialState('anthropic', undefined)
		const second = await store.credentialState('anthropic', undefined)
		expect(first).toEqual({ configured: true, ref: 'ANTHROPIC_API_KEY' })
		expect(second).toEqual(first)
		expect(describeCredential).toHaveBeenCalledTimes(1)
	})

	it('冲突后刷新镜像并以新 revision 重试一次', async () => {
		const scope = scopeStub({ user: {}, value: { providers: { anthropic: {} } }, revision: 1 })
		let calls = 0
		const writeProfile = vi.fn<PiAiOperations['writeProfile']>(async () => {
			calls += 1
			if (calls === 1) {
				scope.push({ revision: 2 })
				return { kind: 'conflict' as const, message: 'stale' }
			}
			return { kind: 'written' as const }
		})
		const { operations } = operationsStub({ writeProfile })
		const { store } = storeOf({ scope, operations })
		await store.refresh()
		await store.saveRoute('anthropic', { displayName: 'Anthropic' })
		expect(writeProfile).toHaveBeenCalledTimes(2)
		expect(writeProfile.mock.calls[1]?.[2]).toBe(2)
		expect(store.getSnapshot().error).toBeNull()
	})

	it('连续冲突时保留错误提示而不是静默吞掉', async () => {
		const scope = scopeStub({ user: {}, value: { providers: { anthropic: {} } }, revision: 1 })
		const { operations } = operationsStub({
			writeProfile: (async () => ({ kind: 'conflict', message: 'stale' })) as PiAiOperations['writeProfile'],
		})
		const { store } = storeOf({ scope, operations })
		await store.refresh()
		await store.saveRoute('anthropic', { displayName: 'Anthropic' })
		expect(store.getSnapshot().error).toContain('其他窗口')
	})

	it('saveRoute 整值写入候选 profile，并连同 API Key 一起保存', async () => {
		const scope = scopeStub({
			user: { providers: { anthropic: { modelOverrides: {} } } },
			value: {},
			revision: 5,
		})
		const storeCredential = vi.fn<PiAiOperations['storeCredential']>(async () => undefined)
		const { operations, writeProfile } = operationsStub({ storeCredential })
		const { store } = storeOf({ scope, operations })
		await store.refresh()
		const ok = await store.saveRoute(
			'anthropic',
			{ displayName: 'A', modelOverrides: { 'claude-x': { id: 'claude-x', maxTokens: 5 } } },
			{ apiKey: 'sk-abc' },
		)
		expect(ok).toBe(true)
		expect(writeProfile).toHaveBeenCalledTimes(1)
		const [provider, profile, revision] = writeProfile.mock.calls[0]!
		expect(provider).toBe('anthropic')
		expect(revision).toBe(5)
		expect(profile).toEqual({
			displayName: 'A',
			apiKeyEnv: 'ANTHROPIC_API_KEY',
			modelOverrides: { 'claude-x': { id: 'claude-x', maxTokens: 5 } },
		})
		expect(storeCredential).toHaveBeenCalledWith('ANTHROPIC_API_KEY', 'sk-abc')
		expect(store.getSnapshot().notice).toContain('已保存')
	})

	it('saveRoute 无变化且无密钥时直接提示而不写入', async () => {
		const scope = scopeStub({ user: { providers: { anthropic: { displayName: 'A' } } }, value: {} })
		const { operations, writeProfile } = operationsStub()
		const { store } = storeOf({ scope, operations })
		await store.refresh()
		const ok = await store.saveRoute('anthropic', { displayName: 'A' })
		expect(ok).toBe(true)
		expect(writeProfile).not.toHaveBeenCalled()
		expect(store.getSnapshot().notice).toContain('没有需要保存的修改')
	})

	it('saveRoute 在 profile 已写入但密钥存储失败时返回失败，便于重试只补密钥', async () => {
		const scope = scopeStub({ user: {}, value: {}, revision: 1 })
		const storeCredential = vi.fn<PiAiOperations['storeCredential']>(async () => 'credentials 服务不可用')
		const { operations, writeProfile } = operationsStub({ storeCredential })
		const { store } = storeOf({ scope, operations })
		await store.refresh()
		const ok = await store.saveRoute('anthropic', { displayName: 'A' }, { apiKey: 'sk-abc' })
		expect(ok).toBe(false)
		expect(writeProfile).toHaveBeenCalledTimes(1)
		expect(store.getSnapshot().error).toContain('API Key 保存失败')
	})

	it('删除 route 只 unset 用户层 profile', async () => {
		const scope = scopeStub({ user: { providers: { anthropic: {} } }, value: {}, revision: 2 })
		const { operations, deleteProfile } = operationsStub()
		const { store } = storeOf({ scope, operations })
		await store.refresh()
		await store.deleteProvider('anthropic')
		expect(deleteProfile).toHaveBeenCalledWith('anthropic', 2)
	})

	it('writable=false 的镜像不阻塞读取，但暴露给 UI', async () => {
		const scope = scopeStub({ user: {}, value: {}, writable: false })
		const { operations } = operationsStub()
		const { store } = storeOf({ scope, operations })
		await store.refresh()
		expect(store.getSnapshot().writable).toBe(false)
		expect(store.getSnapshot().status).toBe('ready')
	})

	it('models.dev 目录按需加载并可强制刷新', async () => {
		const originalFetch = globalThis.fetch
		const body = JSON.stringify({
			demo: {
				id: 'demo',
				name: 'Demo',
				models: { m: { id: 'm', name: 'M', modalities: { input: ['text'], output: ['text'] } } },
			},
		})
		let calls = 0
		globalThis.fetch = (async () => {
			calls += 1
			return calls === 1
				? new Response(body, { status: 200, headers: { etag: '"v1"' } })
				: new Response(body, { status: 200, headers: { etag: '"v1"' } })
		}) as unknown as typeof globalThis.fetch
		try {
			const scope = scopeStub({})
			const { operations } = operationsStub()
			const { store } = storeOf({ scope, operations })
			const loadedCatalog = await store.ensureModelsDev()
			expect(loadedCatalog).toBe(store.getSnapshot().modelsDev)
			expect(store.getSnapshot().modelsDev).not.toBeNull()
			// force=true 绕过缓存重新拉取。
			const forced = await store.ensureModelsDev(true)
			expect(forced).toBe(store.getSnapshot().modelsDev)
			expect(store.getSnapshot().modelsDevError).toBeNull()
			expect(calls).toBeGreaterThanOrEqual(2)
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})
