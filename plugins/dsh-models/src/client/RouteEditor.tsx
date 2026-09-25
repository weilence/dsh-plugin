// route（Provider）编辑页。
//
// 列表页只读；点「编辑」进入本页。左列编辑连接字段与模型清单，右列把
// 「当前草稿对应的完整 providers.<route> 子树」实时渲染成与 settings.yaml
// 同风格的 YAML——所见即最终一次性写入的用户层配置（连接 + 模型一起）。
//
// 草稿语义（与官方写入规则一一对应）：
//   - draftProfile 从用户层现有 profile 克隆起步；绝不能从合成 effective
//     起步，否则会把 schema 默认值与组合 base 物化进用户配置；
//   - 连接字段留在 ProviderDraft，留空 = 保存时从用户层删除该字段 =
//     继承（目录 / base 层），输入框 placeholder 展示继承后的值；
//   - 模型编辑 / 新增 / 删除 / 恢复目录继承都即时折叠进 draftProfile，
//     右侧预览随之更新；
//   - 保存 = 一个 settings.mutate 的整值 set providers.<route>，与预览
//     逐字节一致；API Key（若有）随后只写存入 credentials。
//
// 一个关键细节：草稿的来源状态（inherited / overridden / explicit / declared）
// 随草稿实时重算。目录 route 在会话中物化出 models 清单后，继续编辑或删除
// 模型都会改写 models 数组而不是 modelOverrides——这正是官方语义下的落点。
//
// 外壳为官方 primitives 的 Modal（body portal、遮罩点击 / Escape 关闭、
// aria 由官方维护）。确认对话框打开期间本弹窗忽略自身的关闭事件，
// 一次 Escape / 遮罩点击只关最上层。
// 写入成功等一次性提示由列表页的官方 Toast 呈现，本页不再内联显示。

import { useMemo, useRef, useState } from 'react'
import {
	Button,
	CodeBlock,
	Input,
	Modal,
	StateDot,
	Switch,
	IconPlusOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { discoveredToCatalogEntry } from '../catalog/matching'
import type { ModelsDevCatalog } from '../catalog/types'
import { jsonEqual } from '../pi-ai/ops'
import type { PiAiChoices } from '../pi-ai/choices'
import {
	modelEntries,
	patchUserProfile,
	planAddModel,
	removeModelProfile,
	resetToCatalog,
	routeModelRows,
	routeSource,
	saveModelProfile,
	type DiscoveredModelFacts,
	type ModelRow,
} from '../pi-ai/profile'
import type { PiAiModelEntry, PiAiProviderEntry, RouteSource } from '../pi-ai/types'
import { toRoutePreview } from '../pi-ai/yaml'
import type { PanelRoute } from '../pi-ai/view'
import { deriveKeyRef, validateApiKey } from './operations'
import { ModelForm } from './ModelForm'
import { ModelTable } from './ModelTable'
import { ConfirmDialog } from './ConfirmDialog'
import { TextField, SelectField, fieldInputCls, IssueList } from './ui'
import shared from './shared.module.css'
import local from './RouteEditor.module.css'

const styles = { ...shared, ...local }

export interface RouteEditorProps {
	route: PanelRoute
	choices: PiAiChoices
	/** 该 route 当前继承的目录事实（与写入共用同一输入）。 */
	catalog: ReadonlyMap<string, DiscoveredModelFacts>
	/** 凭据引用当前是否已配置（undefined = 未知）。 */
	keyConfigured: boolean | undefined
	/** settings 文档是否可写。 */
	writable: boolean
	busy: boolean
	/** store 级错误（写入失败等）。 */
	error: string | null
	/** models.dev 目录（获取模型时自动补全元数据）。 */
	modelsDev: ModelsDevCatalog | null
	/** 按需加载目录，并返回结果供当前操作使用。 */
	onLoadModelsDev(): Promise<ModelsDevCatalog | null>
	/** 返回列表（放弃未保存修改，脏时内部会先确认）。 */
	onExit(): void
	/** 获取模型：按草稿连接信息询问 Endpoint 的模型清单（与新建 Provider 同一逻辑）。 */
	onFetchModels(request: {
		provider?: string
		baseURL: string
		api?: string
		apiKey?: string
	}): Promise<readonly { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]>
	/** 保存整份候选 profile；返回是否成功（成功后由调用方决定退出）。 */
	onSave(candidate: PiAiProviderEntry, apiKey?: string): Promise<boolean>
	/** 删除该 route 的用户层 profile（立即执行）。 */
	onDelete(): void
}

interface ProviderDraft {
	displayName: string
	api: string
	baseURL: string
}

/** 连接字段草稿：全部从用户层起步，留空 = 继承（目录 / base）。 */
function initialProviderDraft(route: PanelRoute): ProviderDraft {
	// 不能从合成值起步：目录探测出的 base 层字段一旦被当成「用户写的」
	// 存回去，就等于悄悄固定了它，之后目录升级不再生效。
	// 推理参数格式（thinkingFormat）不再提供 route 级设置，由各模型
	// 在自己的 compat 里按需配置。
	return {
		displayName: typeof route.userProfile?.displayName === 'string' ? route.userProfile.displayName : '',
		api: typeof route.userProfile?.api === 'string' ? route.userProfile.api : '',
		baseURL: typeof route.userProfile?.baseURL === 'string' ? route.userProfile.baseURL : '',
	}
}

const BLANK_ROW: ModelRow = {
	id: '',
	name: '',
	userEntry: undefined,
	catalogEntry: undefined,
	writeSite: 'catalog',
}

/**
 * 草稿行的推理摘要：显式 false = 无推理；字典显示档位；未设置 = 默认。
 */
function draftReasoningText(entry: PiAiModelEntry | undefined): string {
	const efforts = entry?.reasoningEfforts
	if (efforts === false) return '无推理'
	if (efforts === undefined || Object.keys(efforts).length === 0) return '默认'
	return Object.keys(efforts).join('/')
}

/**
 * 只标注用户覆盖过的模型（覆盖）；纯目录继承的行是默认态，不再显示
 * 「目录」徽标。手写 route 与显式清单是 route 级事实，弹窗标题与底部
 * 说明已表达，逐行重复没有信息量，同样不显示。
 */
function draftRowLabel(source: RouteSource, row: ModelRow): string | undefined {
	if (source === 'declared' || source === 'explicit') return undefined
	return row.userEntry === undefined ? undefined : '覆盖'
}

type ModelEdit = { creating: boolean; row: ModelRow }

type Confirm = { kind: 'leave' } | { kind: 'reset' } | { kind: 'delete' }

/** 用户层除 apiKeyEnv 外没有任何自定义项 = 正在使用内置配置。 */
function isBuiltinOnly(profile: PiAiProviderEntry | undefined): boolean {
	if (profile === undefined) return true
	return Object.keys(profile).every((key) => key === 'apiKeyEnv')
}

export function RouteEditor(props: RouteEditorProps) {
	const { route } = props
	const [draftProfile, setDraftProfile] = useState<PiAiProviderEntry>(() =>
		route.userProfile === undefined ? {} : (structuredClone(route.userProfile) as PiAiProviderEntry),
	)
	const [providerDraft, setProviderDraft] = useState<ProviderDraft>(() => initialProviderDraft(route))
	const [key, setKey] = useState('')
	const [modelEdit, setModelEdit] = useState<ModelEdit | undefined>(undefined)
	const [confirm, setConfirm] = useState<Confirm | undefined>(undefined)
	const [touched, setTouched] = useState(false)
	const [localError, setLocalError] = useState<string | null>(null)
	const [fetching, setFetching] = useState(false)
	/** 获取模型的结果反馈：显示在按钮旁边（弹窗顶部的提示区滚动在外，看不见）。 */
	const [fetchStatus, setFetchStatus] = useState<{ kind: 'ok' | 'info' | 'error'; text: string } | undefined>(
		undefined,
	)
	/** 新增模式下已实时应用到草稿的条目 id：支持边输入边改名（移除旧条目再重新规划）。 */
	const formAppliedIdRef = useRef<string | undefined>(undefined)

	/** 打开 / 关闭模型表单：切换目标时清空实时应用的追踪。 */
	const switchModelEdit = (next: ModelEdit | undefined) => {
		formAppliedIdRef.current = undefined
		setModelEdit(next)
	}
	// 内置 provider 的「使用内置配置」：勾选后用户层只保留 API Key 引用，
	// 其余自定义全部清空隐藏；取消勾选时恢复勾选前的草稿（相当于撤销）。
	// 备份初始为挂载时的原始 profile——「初始即勾选」的 route（用户层只有
	// apiKeyEnv）取消勾选时必须回到原始配置，否则 apiKeyEnv 会从候选里丢掉，
	// 预览就会和实际的 settings.yaml 不一致。
	const [useBuiltin, setUseBuiltin] = useState<boolean>(
		() => !route.declared && isBuiltinOnly(route.userProfile),
	)
	const builtinBackupRef = useRef<PiAiProviderEntry>(
		route.userProfile === undefined ? {} : (structuredClone(route.userProfile) as PiAiProviderEntry),
	)

	const keyRef =
		typeof draftProfile.apiKeyEnv === 'string' && draftProfile.apiKeyEnv.length > 0
			? draftProfile.apiKeyEnv
			: deriveKeyRef(route.provider)

	/** 草稿的来源状态：物化（explicit）后继续编辑会走 models 数组，与官方语义一致。 */
	const draftSource = useMemo(() => routeSource(route.declared, draftProfile), [route.declared, draftProfile])
	const rows = useMemo(
		() => routeModelRows(draftSource, draftProfile, props.catalog),
		[draftSource, draftProfile, props.catalog],
	)
	const catalogIds = useMemo(() => new Set(props.catalog.keys()), [props.catalog])

	/**
	 * 最终候选 = 草稿 + 连接字段（整份 providers.<route> 子树，预览即写入）。
	 * compat 原样保留在草稿里：推理参数格式（thinkingFormat）等由各模型
	 * 在自己的条目里配置，route 级不再改写。
	 * 勾选「使用内置配置」时跳过连接字段：草稿只剩 apiKeyEnv（或为空）。
	 */
	const candidate = useMemo(() => {
		const next = patchUserProfile(
			draftProfile,
			useBuiltin
				? {}
				: {
						displayName: providerDraft.displayName.trim() || undefined,
						api: providerDraft.api.trim() || undefined,
						baseURL: providerDraft.baseURL.trim() || undefined,
					},
		)
		// 输入了新密钥但 profile 还没有引用时，把引用写进候选（预览同步显示）。
		if (key.trim().length > 0 && typeof next.apiKeyEnv !== 'string') next.apiKeyEnv = keyRef
		return next
	}, [draftProfile, providerDraft, key, keyRef, useBuiltin])

	const preview = useMemo(() => toRoutePreview(route.provider, candidate), [route.provider, candidate])
	const keyError = key.trim().length > 0 ? validateApiKey(key) : undefined
	const dirty = !jsonEqual(candidate, route.userProfile ?? {}) || key.trim().length > 0

	const issues = useMemo(() => {
		const list: string[] = []
		if (!useBuiltin) {
			if (route.declared && providerDraft.api.trim().length === 0) list.push('手写 route 必须指定 API 协议')
			if (route.declared && providerDraft.baseURL.trim().length === 0) {
				list.push('手写 route 必须指定 Endpoint')
			}
			if (providerDraft.baseURL.trim().length > 0 && !/^https?:\/\//i.test(providerDraft.baseURL.trim())) {
				list.push('Endpoint 必须是可解析的 HTTP 或 HTTPS URL')
			}
			if (modelEntries(candidate).length === 0 && (candidate.models !== undefined || route.declared)) {
				list.push(
					route.declared
						? '手写 route 至少要有一个模型'
						: '模型清单为空；若要恢复目录继承，请点「恢复目录继承」',
				)
			}
		}
		if (keyError !== undefined) list.push(keyError)
		return list
	}, [route.declared, providerDraft, candidate, keyError, useBuiltin])

	/** 「使用内置配置」勾选即清空；取消勾选时恢复勾选前的草稿。 */
	const toggleUseBuiltin = (checked: boolean) => {
		if (checked) {
			builtinBackupRef.current = draftProfile
			const rest: PiAiProviderEntry = {}
			if (typeof draftProfile.apiKeyEnv === 'string' && draftProfile.apiKeyEnv.length > 0) {
				rest.apiKeyEnv = draftProfile.apiKeyEnv
			}
			setDraftProfile(rest)
			setModelEdit(undefined)
		} else {
			setDraftProfile(builtinBackupRef.current)
		}
		setUseBuiltin(checked)
	}

	const rowOf = (id: string) => route.rows.find((row) => row.id === id)
	const factsOf = (id: string) => rowOf(id)?.facts
	// route 级默认容量（schema 默认值）：模型表单容量留空时 placeholder 兜底显示。
	const routeDefaults = {
		contextWindow:
			typeof route.effectiveProfile?.defaultContextWindow === 'number'
				? route.effectiveProfile.defaultContextWindow
				: undefined,
		maxTokens:
			typeof route.effectiveProfile?.defaultMaxTokens === 'number'
				? route.effectiveProfile.defaultMaxTokens
				: undefined,
	}

	const save = async () => {
		setTouched(true)
		setLocalError(null)
		// 模型表单无需先关闭：修改都是实时折叠进草稿的，保存的候选已是最新；
		// 表单里未通过校验的中间态本来就不会进入草稿。保存成功后整个弹窗关闭。
		if (issues.length > 0) return
		const ok = await props.onSave(candidate, key.trim().length > 0 ? key.trim() : undefined)
		if (ok) props.onExit()
	}

	/**
	 * 模型表单实时应用：每次有效修改立即折叠进草稿，右侧预览与列表同步更新；
	 * 文件写入仍由外层「保存」按钮统一完成。
	 *
	 * 新增模式支持边输入边改名：id 变化时先移除上一次应用的旧条目，
	 * 再按新 id 重新规划落点（覆盖 / 物化 / 追加），保证草稿里始终只有一条。
	 * 编辑既有行时 id 不可改，按原位覆盖字段。
	 */
	const applyModelLive = (entry: PiAiModelEntry) => {
		setLocalError(null)
		if (modelEdit === undefined) return
		if (!modelEdit.creating) {
			setDraftProfile(saveModelProfile(draftSource, draftProfile, modelEdit.row, entry))
			return
		}
		if (entry.id.trim().length === 0) return
		const appliedId = formAppliedIdRef.current
		if (appliedId !== undefined && appliedId === entry.id) {
			// 同 id 的后续修改：按当前来源状态原位覆盖该条目。
			const baseRow = rows.find((row) => row.id === appliedId)
			if (baseRow !== undefined) {
				setDraftProfile(saveModelProfile(draftSource, draftProfile, baseRow, entry))
			}
			return
		}
		// 首次应用或改名：先移除旧条目（如有），再按新 id 重新规划。
		let profile = draftProfile
		let source = draftSource
		if (appliedId !== undefined) {
			const previous = rows.find((row) => row.id === appliedId)
			if (previous !== undefined) {
				profile = removeModelProfile(source, profile, previous)
				source = routeSource(route.declared, profile)
			}
		}
		const plan = planAddModel({ source, userProfile: profile, catalog: props.catalog, entry })
		if (plan.kind === 'blocked') {
			setLocalError(plan.reason)
			return
		}
		formAppliedIdRef.current = entry.id
		setDraftProfile(plan.profile)
	}

	const removeModel = (row: ModelRow) => {
		setDraftProfile(removeModelProfile(draftSource, draftProfile, row))
		if (modelEdit !== undefined && modelEdit.row.id === row.id) switchModelEdit(undefined)
	}

	/**
	 * 获取模型：按草稿的 Endpoint + 协议询问 Host（协议留空交给 Host 自行
	 * 判断，凭据未填时回读已存密钥）。返回的模型 id 逐个走 planAddModel
	 * 追加进草稿——已存在的跳过，不重名的加到列表末尾；元数据按
	 * 「当前 Provider 目录内 ID 完全相等 → 已知厂商先 ID 相等再 -尾缀 →
	 * 全目录兜底（多数派容量）」的顺序自动补全。不要的用行上的「删除」移除，
	 * 最后随「保存」一次性写入。
	 */
	const fetchModels = async () => {
		const baseURL = providerDraft.baseURL.trim() || route.baseURL || ''
		if (baseURL.length === 0) {
			setFetchStatus({ kind: 'error', text: '没有可用的 Endpoint；请先在连接里填写' })
			return
		}
		const api = providerDraft.api.trim() || route.api || undefined
		setFetching(true)
		setFetchStatus(undefined)
		try {
			const [discovered, metadataCatalog] = await Promise.all([
				props.onFetchModels({
					provider: route.provider,
					baseURL,
					...(api !== undefined ? { api } : {}),
				}),
				props.modelsDev === null ? props.onLoadModelsDev() : Promise.resolve(props.modelsDev),
			])
			let profile = draftProfile
			let source = draftSource
			const seen = new Set(rows.map((row) => row.id))
			let added = 0
			let skipped = 0
			for (const model of discovered) {
				if (seen.has(model.id)) {
					skipped += 1
					continue
				}
				const plan = planAddModel({
					source,
					userProfile: profile,
					catalog: props.catalog,
					entry: discoveredToCatalogEntry(metadataCatalog, model, route.provider),
				})
				if (plan.kind === 'blocked') {
					setFetchStatus({ kind: 'error', text: plan.reason })
					return
				}
				profile = plan.profile
				source = routeSource(route.declared, profile)
				seen.add(model.id)
				added += 1
			}
			// 循环里只累加了本地 profile 变量，必须在这里折叠回草稿状态，
			// 列表与右侧 YAML 预览才会显示新获取的模型。
			if (added > 0) setDraftProfile(profile)
			setFetchStatus(
				added === 0
					? { kind: 'info', text: '没有新增模型：Endpoint 返回的 id 都已存在' }
					: {
							kind: 'ok',
							text:
								skipped > 0
									? `获取成功：新增 ${added} 个模型，跳过 ${skipped} 个已存在`
									: `获取成功：新增 ${added} 个模型`,
						},
			)
		} catch (error) {
			const message = (error as { message?: string } | null | undefined)?.message
			setFetchStatus({ kind: 'error', text: message || String(error) })
		} finally {
			setFetching(false)
		}
	}

	/**
	 * 拖拽排序模型行。仅显式清单 / 手写 route 有序（models 数组顺序即请求与
	 * 展示顺序）；目录 route 的顺序由安装目录决定，面板不排序。
	 */
	const reorderModel = (from: number, to: number) => {
		if (from === to) return
		if (draftSource !== 'explicit' && draftSource !== 'declared') return
		const entries = [...modelEntries(draftProfile)]
		const [moved] = entries.splice(from, 1)
		entries.splice(to, 0, moved)
		setDraftProfile(patchUserProfile(draftProfile, { models: entries, modelOverrides: undefined }))
	}

	const requestLeave = () => {
		if (dirty) setConfirm({ kind: 'leave' })
		else props.onExit()
	}

	/** Modal 的统一关闭入口：busy 或确认对话框打开时忽略。
	 *  （确认框是官方 Modal 的上一层，Escape 由层栈保证先关它。） */
	const handleClose = () => {
		if (props.busy || confirm !== undefined) return
		requestLeave()
	}

	return (
		<Modal
			open
			onClose={handleClose}
			title={`编辑 Provider · ${route.provider}`}
			closeLabel="关闭"
			description={`${route.declared ? '手写 route（pi-ai 不内置）' : 'pi-ai 目录 route'}${
				route.active ? ' · 活动中' : ' · 未激活'
			} · 左侧编辑，右侧实时预览将写入的完整配置`}
			className={styles.dialogWide}
			contentClassName={styles.scrollBody}
			footer={
				<div className={styles.footer}>
					<span className={styles.footerMeta}>
						{useBuiltin
							? '内置配置：用户层只保留 API Key 引用，其余全部继承安装目录'
							: draftSource === 'declared'
								? '手写清单：保存将改写该 route 的 models 数组'
								: draftSource === 'explicit'
									? '显式清单：保存将改写 models 数组条目'
									: '目录 route：仅写 modelOverrides，其余目录模型保持继承'}
					</span>
					<div className={styles.actions}>
						{!route.declared && !useBuiltin ? (
							<Button variant="outline" disabled={props.busy} onClick={() => setConfirm({ kind: 'reset' })}>
								恢复目录继承
							</Button>
						) : null}
						<Button
							variant="primary"
							className={styles.dangerButton}
							disabled={props.busy}
							onClick={() => setConfirm({ kind: 'delete' })}
						>
							删除 Provider
						</Button>
						<Button variant="outline" disabled={props.busy} onClick={requestLeave}>
							取消
						</Button>
						<Button variant="primary" disabled={props.busy || !props.writable} onClick={() => void save()}>
							{props.busy ? '保存中…' : '保存'}
						</Button>
					</div>
				</div>
			}
		>
			{props.error ? <div className={styles.error}>{props.error}</div> : null}
			{localError ? <div className={styles.error}>{localError}</div> : null}
			{touched && issues.length > 0 ? <IssueList issues={issues.map((message) => ({ message }))} /> : null}
			{!props.writable ? (
				<div className={styles.notice}>
					当前 Settings Provider 不可写；可继续编辑并复制右侧预览，但无法保存。
				</div>
			) : null}
			{route.error ? <div className={styles.error}>{route.error}</div> : null}

			<div className={styles.editorLayout}>
				<div className={styles.editorMain}>
					<section className={styles.section}>
						<h3 className={styles.sectionTitle}>API Key</h3>
						<label className={styles.field}>
							<span className={styles.label}>新的 API Key</span>
							<Input
								className={fieldInputCls(props.busy)}
								type="password"
								autoComplete="off"
								placeholder="留空则不修改"
								value={key}
								disabled={props.busy}
								onChange={(event) => setKey(event.target.value)}
							/>
						</label>{' '}
						{keyError !== undefined ? <div className={styles.error}>{keyError}</div> : null}
						<p className={styles.hint}>
							当前凭据引用：<code className={styles.code}>{keyRef}</code>
							{props.keyConfigured === undefined ? (
								<>
									（<StateDot className={styles.inlineDot} state="idle" /> 状态未知）
								</>
							) : props.keyConfigured ? (
								<>
									（<StateDot className={styles.inlineDot} state="done" /> 已配置）
								</>
							) : (
								<>
									（<StateDot className={styles.inlineDot} state="warning" /> 未配置）
								</>
							)}
							。密钥只写存入 credentials，settings.yaml 里只保留引用名；与保存一起提交。
						</p>
						{!route.declared ? (
							<label className={styles.check}>
								<Switch
									checked={useBuiltin}
									disabled={props.busy}
									onChange={toggleUseBuiltin}
									label="使用内置配置"
								/>
								使用内置配置
								<span className={styles.hintInline}>
									清除显示名、协议、Endpoint 与模型等全部自定义，仅保留 API Key
								</span>
							</label>
						) : null}
					</section>

					{useBuiltin ? null : (
						<>
							<section className={styles.section}>
								<h3 className={styles.sectionTitle}>连接</h3>
								<div className={styles.grid}>
									<TextField
										label="显示名"
										value={providerDraft.displayName}
										disabled={props.busy}
										placeholder={route.displayName || route.provider}
										onChange={(value) => setProviderDraft({ ...providerDraft, displayName: value })}
									/>
									<SelectField
										label="API 协议"
										value={providerDraft.api}
										disabled={props.busy}
										options={props.choices.protocols.map((protocol) => ({
											value: protocol,
											label: protocol,
										}))}
										onChange={(value) => setProviderDraft({ ...providerDraft, api: value })}
									/>
									<TextField
										label="Endpoint（baseURL）"
										wide
										value={providerDraft.baseURL}
										disabled={props.busy}
										placeholder={route.baseURL ?? 'https://gateway.example/v1'}
										onChange={(value) => setProviderDraft({ ...providerDraft, baseURL: value })}
									/>
								</div>
								<p className={styles.hint}>
									API 协议留空 = 继承安装目录 / 上一层的协议（pi-ai 不做自动判断）；显式设置 Endpoint
									会覆盖默认地址（自定义网关常用）。推理参数格式在下方各模型的 compat 里设置。
								</p>
							</section>

							<section className={styles.section}>
								<h3 className={styles.sectionTitle}>模型（{rows.length}）</h3>
								{rows.length > 0 ? (
									<div className={styles.list}>
										<ModelTable
											rows={rows.map((row) => {
												const entry: PiAiModelEntry | undefined = row.userEntry ?? row.catalogEntry
												const rowFacts = factsOf(row.id)
												// 与列表页同一条回退链：条目 → 生效桥 → route 默认
												//（schema 的 defaultMaxTokens 等），避免编辑弹窗里
												// 未显式配置的容量显示成 —。
												const panelRow = rowOf(row.id)
												return {
													key: row.id,
													name: row.name,
													id: row.id,
													badge: draftRowLabel(draftSource, row),
													ctx:
														entry?.contextWindow ??
														rowFacts?.contextWindow ??
														panelRow?.effectiveContextWindow,
													out: entry?.maxTokens ?? rowFacts?.defaultMaxTokens ?? panelRow?.effectiveMaxTokens,
													input: entry?.input ?? rowFacts?.inputModalities,
													reasoning: draftReasoningText(entry),
													onClick: () => switchModelEdit({ creating: false, row }),
													actions: (
														<Button
															variant="ghost"
															size="sm"
															disabled={props.busy}
															// 只改草稿，保存时才真正写入：无需二次确认。
															onClick={() => removeModel(row)}
														>
															删除
														</Button>
													),
												}
											})}
											onReorder={
												draftSource === 'explicit' || draftSource === 'declared' ? reorderModel : undefined
											}
										/>
									</div>
								) : (
									<div className={styles.empty}>
										{route.declared ? '手写 route 至少需要一个模型' : '没有用户层模型配置，全部继承安装目录'}
									</div>
								)}
								{modelEdit !== undefined ? (
									<ModelForm
										key={`${modelEdit.creating ? 'add' : 'edit'}:${modelEdit.row.id}`}
										row={modelEdit.row}
										creating={modelEdit.creating}
										existingRows={
											modelEdit.creating
												? rows.filter((row) => row.id !== formAppliedIdRef.current)
												: rows.filter((row) => row.id !== modelEdit.row.id)
										}
										facts={modelEdit.creating ? undefined : factsOf(modelEdit.row.id)}
										routeDefaults={routeDefaults}
										catalogIds={route.declared ? undefined : catalogIds}
										busy={props.busy}
										onCancel={() => switchModelEdit(undefined)}
										onChange={applyModelLive}
									/>
								) : (
									<>
										<div className={styles.toolbar}>
											<Button
												variant="outline"
												icon={<IconPlusOutlineRegular />}
												disabled={props.busy}
												onClick={() => switchModelEdit({ creating: true, row: BLANK_ROW })}
											>
												新增模型
											</Button>
											<Button
												variant="outline"
												disabled={props.busy || fetching}
												onClick={() => {
													void fetchModels()
												}}
											>
												{fetching ? '获取中…' : '获取模型'}
											</Button>
										</div>
										{fetchStatus !== undefined ? (
											<div
												className={
													fetchStatus.kind === 'ok'
														? styles.success
														: fetchStatus.kind === 'error'
															? styles.error
															: styles.notice
												}
												role={fetchStatus.kind === 'error' ? 'alert' : undefined}
											>
												{fetchStatus.text}
											</div>
										) : null}
									</>
								)}
							</section>
						</>
					)}
				</div>

				<aside className={styles.editorAside}>
					<h3 className={styles.sectionTitle}>将写入的 settings.yaml</h3>
					<CodeBlock
						className={styles.previewPane}
						code={preview}
						lang="yaml"
						copyLabel="复制"
						copiedLabel="已复制"
					/>
				</aside>
			</div>

			{confirm !== undefined ? (
				<ConfirmDialog
					title={
						confirm.kind === 'delete'
							? `删除 Provider ${route.provider}`
							: confirm.kind === 'reset'
								? '恢复目录继承'
								: '放弃未保存的修改？'
					}
					body={
						confirm.kind === 'delete'
							? '只删除 llm-pi-ai 用户层里的这条 profile（凭据与组合层配置保留）。未保存的修改将一并丢弃。'
							: confirm.kind === 'reset'
								? '将清空用户层的 models 与 modelOverrides（连接字段保留）；预览会立即反映，保存后生效。'
								: '有未保存的修改，离开将丢弃。'
					}
					confirmLabel={confirm.kind === 'delete' ? '删除' : '确定'}
					busy={props.busy}
					onCancel={() => setConfirm(undefined)}
					onConfirm={() => {
						const target = confirm
						setConfirm(undefined)
						if (target.kind === 'leave') props.onExit()
						else if (target.kind === 'reset') {
							setDraftProfile(resetToCatalog(draftProfile))
							setModelEdit(undefined)
						} else props.onDelete()
					}}
				/>
			) : null}
		</Modal>
	)
}
