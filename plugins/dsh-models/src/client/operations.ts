// llm-pi-ai 面板用到的 Host 操作。
//
// 读取分三路，全部只是既有 Remote 的薄包装：
//   - `remote.settings` / configForms：配置文档（写用 mutate，读走共享表单镜像）
//   - `remote.llm`：route 目录、活动状态、安装目录模型、端点探测
//   - `remote.credentials`：API Key 状态与只写存储
// 加本插件自己的 Host 只读桥（/dsh-models/effective-models），用于读取某个
// route 当前真正生效的能力（模态 / 容量 / 可选推理档）。
//
// 写入策略：一次动作 = 一个 `settings.mutate`，只 set/unset 目标 route 的
// 子树，携带读取时的 revision。`settings/conflict` 由调用方决定是否重试。

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {
	CredentialInfo,
	LlmConfigurableProvider,
	LlmDiscoveredModel,
	LlmProviderInfo,
	SettingsNamespaceView,
	SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { classifyWrite, type WriteOutcome } from '../pi-ai/ops'
import { errMsg } from './utils'

export const PI_AI_NS = 'llm-pi-ai'
export const EFFECTIVE_PATH = '/dsh-models/effective-models'
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000

/** 一个 route 的目录事实（settings 目录 + 活动状态合并）。 */
export interface RouteDirectoryRow {
	provider: string
	displayName: string
	/** pi-ai 在该键下不提供任何内容 → 手工声明 route。 */
	declared: boolean
	/** 当前是否有活动 registration。 */
	active: boolean
	/** Host 报告的配置诊断。 */
	error?: string
}

/** 一个模型通过 Host 解析出的当前生效能力。 */
export interface EffectiveModelFacts {
	id: string
	name: string
	inputModalities?: readonly string[]
	contextWindow?: number
	defaultMaxTokens?: number
	reasoning?: {
		efforts: readonly { id: string; name: string }[]
		defaultEffort?: string
	}
}

/** 一次有效能力查询的结果。 */
export type EffectiveOutcome =
	{ kind: 'found'; models: readonly EffectiveModelFacts[] } | { kind: 'unavailable'; message: string }

export interface PiAiOperations {
	/** 读取 route 目录：设置目录条目 + 活动 route，合并成面板行。 */
	loadDirectory(): Promise<RouteDirectoryRow[]>
	/** 读一个 route 的安装目录模型；pi-ai 不提供该 route 时返回 undefined。 */
	discover(provider: string): Promise<readonly LlmDiscoveredModel[] | undefined>
	/**
	 * 询问一个草稿 Endpoint 提供的模型清单（「获取模型」用）。
	 * 携带 provider 时 Host 可回读该 route 已存凭据（草稿未填 key 的场景）；
	 * Host 侧按协议走原生模型列表接口（openai 的 /models 等）；失败时抛错。
	 */
	discoverEndpoint(request: {
		provider?: string
		baseURL: string
		api?: string
		apiKey?: string
	}): Promise<readonly LlmDiscoveredModel[]>
	/** 读一个 route 当前生效的能力（只读桥）。 */
	effective(provider: string): Promise<EffectiveOutcome>
	/** 提交一个 route 的整值写入。 */
	writeProfile(
		provider: string,
		profile: Record<string, unknown>,
		expectedRevision: number | undefined,
	): Promise<WriteOutcome>
	/** 删除一个 route 的用户层 profile。 */
	deleteProfile(provider: string, expectedRevision: number | undefined): Promise<WriteOutcome>
	/** 读一个凭据引用的状态。 */
	describeCredential(ref: string): Promise<CredentialInfo | undefined>
	/** 只写存储一个凭据；返回失败信息或 undefined。 */
	storeCredential(ref: string, value: string): Promise<string | undefined>
}

/** 从 Remote 失败结果里取诊断文本。 */
function remoteMessage(error: { message?: string } | undefined, fallback: string) {
	return error?.message || fallback
}

/**
 * 本插件需要的 Client 服务面。
 *
 * 刻意用结构化类型而不是 `extends Context`：官方包通过 module augmentation
 * 给 Context 挂上完整服务类型，手写接口一旦继承就会与官方声明冲突（半个
 * 服务类型无法满足整个 `remote`）。真正的绑定发生在 apply 的一次断言上。
 */
export interface OperationsContext {
	remote: {
		llm: {
			listProviders(): Promise<
				{ ok: true; value: readonly LlmProviderInfo[] } | { ok: false; error: { message: string } }
			>
			listConfigurableProviders(): Promise<
				{ ok: true; value: readonly LlmConfigurableProvider[] } | { ok: false; error: { message: string } }
			>
			discoverModels(
				settingsNs: string,
				request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
				signal?: AbortSignal,
			): Promise<
				{ ok: true; value: readonly LlmDiscoveredModel[] } | { ok: false; error: { message: string } }
			>
		}
		credentials: {
			describe(
				refs: readonly string[],
			): Promise<
				{ ok: true; value: Record<string, CredentialInfo> } | { ok: false; error: { message: string } }
			>
			set(
				ref: string,
				value: string,
			): Promise<{ ok: true; value: void } | { ok: false; error: { message: string } }>
			unset(ref: string): Promise<{ ok: true; value: void } | { ok: false; error: { message: string } }>
		}
		settings: {
			mutate(
				ns: string,
				ops: readonly SettingsPathOpView[],
				expectedRevision?: number,
			): Promise<
				{ ok: true; value: SettingsNamespaceView } | { ok: false; error: { code?: string; message: string } }
			>
		}
	}
	configForms: {
		describe(): { acceptView(view: SettingsNamespaceView): void }
	}
}

export function createOperations(ctx: OperationsContext): PiAiOperations {
	return {
		async loadDirectory() {
			const [configurable, registered] = await Promise.all([
				ctx.remote.llm.listConfigurableProviders(),
				ctx.remote.llm.listProviders(),
			])
			if (!configurable.ok) throw new Error(remoteMessage(configurable.error, '读取 Provider 目录失败'))
			const active = new Set(registered.ok ? registered.value.map((row) => row.id) : [])
			return configurable.value.map((entry) => ({
				provider: entry.provider,
				displayName: entry.displayName,
				declared: entry.declared === true,
				active: active.has(entry.provider),
				...(entry.error === undefined ? {} : { error: entry.error }),
			}))
		},

		async discover(provider) {
			const response = await ctx.remote.llm.discoverModels(PI_AI_NS, { provider })
			if (response.ok) return response.value
			// 手工声明 route 没有安装目录；这不是错误，只是没有可继承的模型。
			return undefined
		},

		async discoverEndpoint(request) {
			// 只限制按钮触发的 Endpoint 询问；安装目录的 discover 不受影响。
			// 同时取消 Host 请求并让 UI 准时结束等待（即使 Remote 没及时响应取消）。
			const controller = new AbortController()
			let timer: ReturnType<typeof setTimeout> | undefined
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error('获取模型列表超时（5 秒）'))
					controller.abort()
				}, MODEL_DISCOVERY_TIMEOUT_MS)
			})
			try {
				const response = await Promise.race([
					ctx.remote.llm.discoverModels(PI_AI_NS, request, controller.signal),
					timeout,
				])
				if (!response.ok) throw new Error(remoteMessage(response.error, '获取模型列表失败'))
				return response.value
			} finally {
				clearTimeout(timer)
			}
		},

		async effective(provider) {
			try {
				const response = await fetch(`${EFFECTIVE_PATH}?provider=${encodeURIComponent(provider)}`, {
					method: 'GET',
					headers: { Accept: 'application/json' },
				})
				const text = await response.text()
				let body: unknown
				try {
					body = JSON.parse(text)
				} catch {
					return {
						kind: 'unavailable',
						message: `Host 生效能力接口返回了无效 JSON（HTTP ${response.status}）`,
					}
				}
				const record = body as { models?: unknown; error?: unknown }
				if (!response.ok) {
					const message = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`
					return { kind: 'unavailable', message }
				}
				if (!Array.isArray(record.models))
					return { kind: 'unavailable', message: 'Host 生效能力接口响应缺少 models' }
				const models = record.models.flatMap((raw): EffectiveModelFacts[] => {
					if (typeof raw !== 'object' || raw === null) return []
					const item = raw as EffectiveModelFacts
					return typeof item.id === 'string' && item.id.length > 0 ? [item] : []
				})
				return { kind: 'found', models }
			} catch (error) {
				return { kind: 'unavailable', message: errMsg(error) }
			}
		},

		async writeProfile(provider, profile, expectedRevision) {
			const response = await ctx.remote.settings.mutate(
				PI_AI_NS,
				[{ op: 'set', path: ['providers', provider], value: profile as never }],
				expectedRevision,
			)
			if (response.ok) ctx.configForms.describe().acceptView(response.value)
			return classifyWrite(response)
		},

		async deleteProfile(provider, expectedRevision) {
			const response = await ctx.remote.settings.mutate(
				PI_AI_NS,
				[{ op: 'unset', path: ['providers', provider] }],
				expectedRevision,
			)
			if (response.ok) ctx.configForms.describe().acceptView(response.value)
			return classifyWrite(response)
		},

		async describeCredential(ref) {
			const response = await ctx.remote.credentials.describe([ref])
			return response.ok ? response.value[ref] : undefined
		},

		async storeCredential(ref, value) {
			const response = await ctx.remote.credentials.set(ref, value)
			return response.ok ? undefined : remoteMessage(response.error, '保存 API Key 失败')
		},
	}
}

/**
 * 面板派生的凭据引用：官方 Models 页同款规则（`<ROUTE>_API_KEY`）。
 * 只在 UI 提示与「新 route 首次写入」时使用。
 */
export function deriveKeyRef(provider: string) {
	return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** 只写输入框的密钥格式校验（HTTP header 可携带的可打印 ASCII）。 */
export function validateApiKey(raw: string): string | undefined {
	const value = raw.trim()
	if (value.length === 0) return 'API Key 不能为空'
	if (!/^[\x21-\x7E]+$/.test(value)) return 'API Key 只能包含可打印 ASCII 字符；请粘贴原始密钥'
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return '这看起来是环境变量赋值；请只粘贴密钥本身'
	return undefined
}
