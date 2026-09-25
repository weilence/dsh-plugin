// models.dev 辅助的新建 Provider 表单。
//
// 一页完成：填 Provider ID / 显示名 / API Key → 选 Endpoint（可从 models.dev
// 的 Provider 里选，也可手动填自定义地址）→ 「获取模型」用 API Key 询问该
// Endpoint 的模型清单（Host 的 llm/discoverModels，按协议走原生模型列表
// 接口），并按 models.dev 元数据补全每个模型的能力（modelToEntry：
// contextWindow / maxTokens / input / reasoningEfforts）。缺失的值不写入
// 配置，列表展示时按官方 route 默认兜底显示（262144 / 32768 / ['text'] /
// 推理「默认」）→ 一次写入。
//
// 模型清单默认为空：不获取也可以直接创建，进编辑页再补。API 协议（api）默认
// 为空：选中 models.dev 建议时自动带出映射出的协议，也可手动填写（获取模型与
// 创建都以手填值优先）；自定义 Endpoint 未填协议时，「获取模型」按最常见的
// openai-completions 询问 /models，创建时只写 baseURL，协议留到编辑页补全。
//
// 本组件只渲染 body 片段，由「新建 Provider」弹窗（官方 Modal）内嵌使用，
// 自身不带弹窗外壳；「创建」动作经 ref 暴露给外层 Modal 的 footer。
//
// 写入用官方格式：选中 models.dev 来源时按其元数据声明 api + baseURL（无特殊
// 分支，对内置同名 ID 也不做额外处理）；自定义 Endpoint 只写 baseURL，协议留
// 到编辑页补全。唯一校验是 Provider ID 不得与已配置 route 重复。

import { useMemo, useState, forwardRef, useImperativeHandle } from 'react'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { discoveredToCatalogEntry } from '../catalog/matching'
import { planProviderCreation } from '../catalog/map'
import type { ModelsDevCatalog, ModelsDevProvider } from '../catalog/types'
import type { PiAiModelEntry, PiAiProviderEntry } from '../pi-ai/types'
import type { PanelRoute } from '../pi-ai/view'
import { ModelTable } from './ModelTable'
import { Field, TextField, fieldInputCls } from './ui'
import { errMsg } from './utils'
import styles from './shared.module.css'

export interface ModelsDevImportProps {
	catalog: ModelsDevCatalog | null
	loading: boolean
	error: string | null
	/** 已配置的 route：目标 ID 命中即拒绝——只能新建 Provider。 */
	routes: readonly PanelRoute[]
	busy: boolean
	onCancel(): void
	/** 获取模型：按 Endpoint + 协议 + 一次性 API Key 询问 Host 的模型清单。 */
	onFetchModels(request: {
		baseURL: string
		api: string
		apiKey?: string
	}): Promise<readonly LlmDiscoveredModel[]>
	/** 整值写入候选 profile；返回是否成功。 */
	onSaveProfile(
		provider: string,
		profile: PiAiProviderEntry,
		notice: string,
		apiKey?: string,
	): Promise<boolean>
	onError(message: string): void
}

/** ref 面：外层 Modal footer 上的「创建」按钮触发这里。 */
export interface ModelsDevImportHandle {
	apply(): void
}

/** Endpoint 下拉的候选：models.dev 里有 API Endpoint 的 Provider。 */
function endpointOptions(catalog: ModelsDevCatalog | null): readonly ModelsDevProvider[] {
	return (catalog?.providers ?? []).filter(
		(provider): provider is ModelsDevProvider & { api: string } =>
			typeof provider.api === 'string' && provider.api.length > 0,
	)
}

/** api 框的建议集：pi-ai 支持的三种线上协议。 */
const KNOWN_PROTOCOLS: readonly string[] = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** models.dev 来源 → 可安全映射的 pi-ai 协议；映射不了（unsupported）返回 undefined。 */
function mappedProtocol(provider: ModelsDevProvider): string | undefined {
	const plan = planProviderCreation(provider)
	return plan.kind === 'custom' ? String(plan.profile['api']) : undefined
}

/** 官方 llm-pi-ai 的 route 级容量回退：列表对缺失值按这两个值兜底显示。 */
const FALLBACK_CONTEXT_WINDOW = 262_144
const FALLBACK_MAX_TOKENS = 32_768

/** 推理强度摘要：显式 false = 无推理；字典显示档位；未设置 = 默认（继承）。 */
function reasoningDisplay(entry: PiAiModelEntry) {
	if (entry.reasoningEfforts === false) return '无推理'
	const efforts = entry.reasoningEfforts
	if (efforts === undefined || Object.keys(efforts).length === 0) return '默认'
	return Object.keys(efforts).join('/')
}

/** 「新建 Provider」表单：填连接信息 → 获取模型 → 一次写入。 */
export const ModelsDevImport = forwardRef<ModelsDevImportHandle, ModelsDevImportProps>(
	function ModelsDevImport(props, ref) {
		const [providerId, setProviderId] = useState('')
		const [displayName, setDisplayName] = useState('')
		const [apiKey, setApiKey] = useState('')
		const [endpoint, setEndpoint] = useState('')
		/** 用户可改的线上协议；默认空。选中 models.dev 建议时自动带出。 */
		const [api, setApi] = useState('')
		/** null = 还没获取过；[] = 获取过但 Endpoint 没返回模型。 */
		const [models, setModels] = useState<readonly PiAiModelEntry[] | null>(null)
		const [fetching, setFetching] = useState(false)
		const [fetchError, setFetchError] = useState<string | null>(null)
		const endpointValue = endpoint.trim()
		// Endpoint 与 models.dev 某个来源的 api 完全一致 → 按「选择」处理；
		// 手动改过（或留空）就是自定义 Endpoint。
		const source = useMemo(() => {
			if (endpointValue.length === 0) return undefined
			return endpointOptions(props.catalog).find((provider) => provider.api === endpointValue)
		}, [props.catalog, endpointValue])
		// 导入只新建 provider，没有目录继承问题：统一按来源元数据映射 api + baseURL，
		// 映射不了（unsupported）则不允许创建。
		const plan = useMemo(() => (source ? planProviderCreation(source) : undefined), [source])

		const target = providerId.trim()
		const existing = props.routes.some((route) => route.provider === target)
		const apiValue = api.trim()

		const fetchModels = async () => {
			if (endpointValue.length === 0) return
			setFetching(true)
			setFetchError(null)
			try {
				// 协议取值顺序：手动填写的 api 框 > models.dev 映射出的协议 >
				// openai-completions 兜底（失败会在下方提示）。
				const protocol =
					apiValue.length > 0
						? apiValue
						: source !== undefined && plan?.kind === 'custom'
							? String(plan.profile['api'])
							: 'openai-completions'
				const discovered = await props.onFetchModels({
					baseURL: endpointValue,
					api: protocol,
					apiKey: apiKey.trim().length > 0 ? apiKey.trim() : undefined,
				})
				// 先与当前 Endpoint 对应的目录来源按 ID 完全相等补全能力；未命中时
				// 再按模型 ID 前缀定位已知厂商（可忽略 -尾缀）；仍无命中则跨全目录
				// 兜底（多数派容量）。目录没有对应项时保留 Endpoint 返回值。
				setModels(discovered.map((model) => discoveredToCatalogEntry(props.catalog, model, source?.id)))
			} catch (error) {
				setFetchError(errMsg(error))
			} finally {
				setFetching(false)
			}
		}

		const apply = async () => {
			if (target.length === 0) {
				props.onError('新 Provider ID 不能为空')
				return
			}
			if (existing) {
				props.onError(`Provider ID「${target}」已存在；只能新建 Provider`)
				return
			}
			if (plan?.kind === 'unsupported' && apiValue.length === 0) {
				props.onError(plan.reason)
				return
			}
			// 选中 models.dev 来源：按其元数据声明 api + baseURL；
			// 自定义 Endpoint：写 baseURL，协议取 api 框（留空则编辑页补全）。
			// api 框非空时用户填写的值优先。displayName 只在填写时才写入：
			// 留空 = 不写这个配置，展示回退 Provider ID。
			const displayNameValue = displayName.trim()
			const planned: Record<string, unknown> = plan?.kind === 'custom' ? { ...plan.profile } : {}
			if (displayNameValue.length > 0) planned['displayName'] = displayNameValue
			else delete planned['displayName']
			const profile = {
				...planned,
				...(endpointValue.length > 0 ? { baseURL: endpointValue } : {}),
				...(apiValue.length > 0 ? { api: apiValue } : {}),
				models: models ?? [],
			} as PiAiProviderEntry
			const ok = await props.onSaveProfile(
				target,
				profile,
				models === null || models.length === 0
					? `已创建 Provider ${target}（模型清单为空，可在编辑页继续添加）`
					: `已创建 Provider ${target}（${models.length} 个模型）`,
				apiKey.trim().length > 0 ? apiKey.trim() : undefined,
			)
			if (ok) props.onCancel()
		}

		// 每次渲染重建 handle：apply 闭包永远读到最新 state，无过期问题。
		useImperativeHandle(ref, () => ({
			apply: () => {
				void apply()
			},
		}))

		const canCreate = target.length > 0 && !existing && (plan?.kind !== 'unsupported' || apiValue.length > 0)
		const canFetch = endpointValue.length > 0
		const protocolLabel = plan?.kind === 'custom' ? String(plan.profile['api']) : ''

		return (
			<>
				{props.loading && !props.catalog ? (
					<div className={styles.loading}>正在读取 Host 的 models.dev 目录…</div>
				) : null}
				{props.error ? (
					<div className={styles.error} role="alert">
						{props.error}
					</div>
				) : null}

				{props.catalog ? (
					<>
						<div className={styles.grid}>
							<Field label="Provider">
								<Input
									className={fieldInputCls()}
									value={endpoint}
									placeholder="https://api.example.com/v1"
									list="dsh-models-endpoint-options"
									onChange={(event) => {
										const next = event.target.value
										setModels(null)
										setFetchError(null)
										setEndpoint(next)
										// datalist 没有独立的「选中」事件，但选中建议时
										// onChange 会带上完整值：命中 models.dev 建议就
										// 自动带出协议；映射不了的来源不动 api 框。
										const matched = endpointOptions(props.catalog).find(
											(provider) => provider.api === next.trim(),
										)
										if (matched) {
											const protocol = mappedProtocol(matched)
											if (protocol !== undefined) setApi(protocol)
										}
									}}
								/>
								<datalist id="dsh-models-endpoint-options">
									{endpointOptions(props.catalog).map((item) => (
										<option key={item.id} value={item.api}>
											{item.name}
										</option>
									))}
								</datalist>
							</Field>
							<TextField
								label="API Key（可选）"
								type="password"
								autoComplete="off"
								value={apiKey}
								onChange={setApiKey}
							/>
							<TextField
								label="Provider ID"
								value={providerId}
								placeholder={source?.id ?? ''}
								onChange={setProviderId}
							/>
							<TextField
								label="显示名（可选；留空不写入配置）"
								value={displayName}
								onChange={setDisplayName}
							/>
							<Field label="API 协议（api；可留空，创建后在编辑页补全）">
								<Input
									className={fieldInputCls()}
									value={api}
									placeholder={protocolLabel || 'openai-completions'}
									list="dsh-models-api-options"
									onChange={(event) => setApi(event.target.value)}
								/>
								<datalist id="dsh-models-api-options">
									{KNOWN_PROTOCOLS.map((protocol) => (
										<option key={protocol} value={protocol} />
									))}
								</datalist>
							</Field>
						</div>
						{existing ? (
							<div className={styles.error} role="alert">
								Provider ID「{target}」已存在；只能新建 Provider。
							</div>
						) : plan?.kind === 'unsupported' && apiValue.length === 0 ? (
							<div className={styles.error} role="alert">
								{plan.reason}；也可在「API 协议」框手动填写后创建。
							</div>
						) : null}
						<div className={styles.toolbar}>
							<Button
								variant="outline"
								disabled={props.busy || fetching || !canFetch}
								onClick={() => {
									void fetchModels()
								}}
							>
								{fetching ? '获取中…' : '获取模型'}
							</Button>
							<span className={styles.footerMeta}>{models !== null ? `共 ${models.length} 个模型` : ''}</span>
						</div>
						{fetchError ? (
							<div className={styles.error} role="alert">
								{fetchError}
							</div>
						) : null}
						<div className={styles.list}>
							{models === null ? (
								<div className={styles.empty}>模型清单为空；点「获取模型」拉取，或创建后在编辑页添加。</div>
							) : models.length === 0 ? (
								<div className={styles.empty}>Endpoint 没有返回任何模型。</div>
							) : (
								<ModelTable
									rows={models.map((model) => ({
										key: model.id,
										name: model.name ?? model.id,
										id: model.id,
										ctx: model.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
										out: model.maxTokens ?? FALLBACK_MAX_TOKENS,
										input: model.input ?? ['text'],
										reasoning: reasoningDisplay(model),
									}))}
								/>
							)}
						</div>
					</>
				) : null}
			</>
		)
	},
)
