// 模型目录列表页（settings.section 的面板本体）。
//
// 两种视图：
//   - 列表（默认）：只读浏览 Provider 与其模型清单，动作是「编辑」与
//     「新建 Provider」（弹窗见 CreateProviderDialog.tsx；编辑页见
//     RouteEditor.tsx）。行卡片可拖拽排序，顺序存浏览器本地，仅影响
//     本面板展示，不写入配置。
//   - 「删除 Provider」走 ConfirmDialog，确认后由 store 执行。
//
// 行列表只展示「真的配置过」的 route：官方 llm-pi-ai 会把整份 pi-ai 内置
// 目录都声明进可配置目录，在面板上平铺全量，会把几十个从未配置过的内置
// provider 当成「账号列表」。官方 Models 页的规则是：行只显示已配置项，
// 未配置的内置 provider 只出现在「新建 Provider」的下拉里——这里与它对齐。

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, Toast, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { reasoningLabel, type PanelRoute } from '../pi-ai/view'
import type { PiAiOperations } from './operations'
import type { PanelStore } from './store'
import { RouteEditor } from './RouteEditor'
import { CreateProviderDialog } from './CreateProviderDialog'
import { ModelTable } from './ModelTable'
import { ConfirmDialog } from './ConfirmDialog'
import { useRowDragReorder, type RowDragHandlers } from './drag'
import shared from './shared.module.css'
import local from './ModelCatalogSection.module.css'

const styles = { ...shared, ...local }

/** Provider 展示顺序的本地存储键（仅影响面板显示，不写入配置）。 */
const PROVIDER_ORDER_KEY = 'dsh-models/provider-order'

function usePanelState(store: PanelStore) {
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** 列表页的一个 route 行：只读展示 Provider 与模型清单，动作是「编辑」「删除」。 */
function RouteRow(props: {
	route: PanelRoute
	busy: boolean
	onEdit(): void
	/** 弹出删除确认（真正删除由外层执行）。 */
	onDelete(): void
	/** 拖拽排序（存储于浏览器本地，仅影响本面板展示顺序）。 */
	dragging: boolean
	/** 插入线位置：本卡片的顶边 / 底边（插入下标语义，由 drag.lineAt 计算）。 */
	dropLine: 'top' | 'bottom' | null
	/** 行拖拽属性：start / end 在表头，over / drop 在整卡（可从卡片任意处拖入）。 */
	dragHandlers: RowDragHandlers
}) {
	const { route, dragHandlers } = props
	const [open, setOpen] = useState(false)
	return (
		<section
			className={[
				styles.route,
				open ? styles.routeOpen : '',
				props.dropLine === 'top' ? styles.routeLineTop : '',
				props.dropLine === 'bottom' ? styles.routeLineBottom : '',
				props.dragging ? styles.routeDragging : '',
			]
				.filter(Boolean)
				.join(' ')}
			onDragOver={dragHandlers.onDragOver}
			onDrop={dragHandlers.onDrop}
		>
			{/* 整行可点击展开；编辑按钮区域阻止冒泡。表头可拖拽排序。
			    对齐官方 settings 卡片：标题在左，编辑按钮与展开箭头在右
			    （按钮在箭头左侧），箭头朝下 = 收起、旋转 180° = 展开。 */}
			<header
				className={styles.routeHead}
				role="button"
				tabIndex={0}
				aria-expanded={open}
				aria-label={`展开 ${route.displayName} 的模型清单`}
				draggable={dragHandlers.draggable}
				onDragStart={dragHandlers.onDragStart}
				onDragEnd={dragHandlers.onDragEnd}
				onClick={() => setOpen(!open)}
				onKeyDown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault()
						setOpen(!open)
					}
				}}
			>
				<div className={styles.routeHeadMain}>
					<span className={styles.routeTitleRow}>
						<span className={styles.routeDisplayName}>{route.displayName}</span>
						<span className={styles.routeId}>{route.provider}</span>
					</span>
					<div className={styles.routeInfo}>
						{route.api !== undefined ? (
							<span className={styles.routeInfoItem}>
								<span className={styles.routeInfoLabel}>API</span>
								<span className={styles.routeInfoValue}>{route.api}</span>
							</span>
						) : null}
						{route.baseURL !== undefined ? (
							<span className={styles.routeInfoItem}>
								<span className={styles.routeInfoLabel}>Endpoint</span>
								<span className={styles.routeInfoValue}>{route.baseURL}</span>
							</span>
						) : null}
					</div>
				</div>
				<div className={styles.routeActions} onClick={(event) => event.stopPropagation()}>
					<Button variant="outline" size="sm" disabled={props.busy} onClick={props.onEdit}>
						编辑
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className={styles.dangerGhost}
						disabled={props.busy}
						onClick={props.onDelete}
					>
						删除
					</Button>
				</div>
				<span className={open ? `${styles.routeCaret} ${styles.routeCaretOpen}` : styles.routeCaret}>
					<IconChevronDownOutlineRegular />
				</span>
			</header>
			{route.error ? <div className={styles.error}>{route.error}</div> : null}
			{open ? (
				<div className={styles.routeList}>
					{route.rows.length > 0 ? (
						<ModelTable
							rows={route.rows.map((row) => ({
								key: row.id,
								name: row.name,
								id: row.id,
								ctx: row.effectiveContextWindow,
								out: row.effectiveMaxTokens,
								input: row.effectiveInput,
								reasoning: reasoningLabel(row),
							}))}
						/>
					) : (
						<div className={styles.empty}>
							{route.active ? '该 route 当前没有可用模型' : '该 route 未激活或未配置模型'}
						</div>
					)}
				</div>
			) : null}
		</section>
	)
}

export interface ModelCatalogSectionProps extends SettingsSectionOwnerProps {
	store?: PanelStore
	operations?: PiAiOperations
}

export function ModelCatalogSection(props: ModelCatalogSectionProps) {
	const store = props.store
	const operations = props.operations
	if (!store || !operations) {
		return <div className={styles.empty}>模型目录面板尚未注入。</div>
	}
	return <ModelCatalogPanel store={store} operations={operations} close={props.close} />
}

function ModelCatalogPanel(props: { store: PanelStore; operations: PiAiOperations; close: () => void }) {
	const state = usePanelState(props.store)
	// notice 存在长寿命的 store 里，唯一清除路径是 Toast 的 onDone；而 Toast
	// 的计时（holdMs + 淡出）只在挂载期间有效，切走菜单 / 关闭设置会连面板
	// 一起卸载并 clearTimeout，残留的 notice 会在下次打开时重放成「刚保存
	// 过」的假象。面板卸载时同步清掉尚未淡出的提示。
	useEffect(() => () => props.store.dismissNotice(), [props.store])
	/** 正在编辑的 route（undefined = 列表视图）。 */
	const [editing, setEditing] = useState<string | undefined>(undefined)
	const [creating, setCreating] = useState(false)
	/** 待确认删除的 route：确认后走 store.deleteProvider。 */
	const [deleting, setDeleting] = useState<string | undefined>(undefined)
	const [keyState, setKeyState] = useState<Record<string, boolean | undefined>>({})

	// 行列表只展示「真的配置过」的 route。useMemo：state.routes 引用不变时
	// 保持同一数组——若直接 filter，每次渲染都会产生新数组，下面的凭据 effect
	// 将在每次渲染后重跑，配合 setState 形成「describe 不停调用」的无限循环。
	// 休眠的内置 route 不属于已创建 Provider，不能用于新建弹窗的查重。
	const routes = useMemo(() => state.routes.filter((route) => route.configured), [state.routes])
	/** 尚未配置的 pi-ai 内置 provider（仅作新建流程的候选）。 */
	const dormant = useMemo(() => state.routes.filter((route) => !route.configured), [state.routes])
	const editingRoute = editing === undefined ? undefined : routes.find((route) => route.provider === editing)

	// 逐 route 读一次凭据状态（编辑弹窗里的小圆点）。store 按引用缓存 describe
	// 结果，同一快照下重复渲染不会再次请求。
	useEffect(() => {
		let cancelled = false
		for (const route of routes) {
			void props.store.credentialState(route.provider, route.apiKeyEnv).then((result) => {
				if (cancelled || !result) return
				setKeyState((previous) =>
					previous[route.provider] === result.configured
						? previous
						: { ...previous, [route.provider]: result.configured },
				)
			})
		}
		return () => {
			cancelled = true
		}
	}, [props.store, routes])

	const writable = state.writable
	const busyProvider = state.busy

	// Provider 展示顺序：拖拽排序结果存浏览器本地（localStorage），仅影响本
	// 面板的显示，不改写任何配置。新出现的 provider 追加在已存顺序之后。
	const [providerOrder, setProviderOrder] = useState<string[] | null>(() => {
		try {
			const raw = window.localStorage.getItem(PROVIDER_ORDER_KEY)
			const parsed: unknown = raw === null ? null : JSON.parse(raw)
			return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : null
		} catch {
			return null
		}
	})

	const orderedRoutes = useMemo(() => {
		if (providerOrder === null) return routes
		const position = new Map(providerOrder.map((id, order) => [id, order]))
		return [...routes].sort(
			(a, b) =>
				(position.get(a.provider) ?? Number.MAX_SAFE_INTEGER) -
				(position.get(b.provider) ?? Number.MAX_SAFE_INTEGER),
		)
	}, [routes, providerOrder])

	/** 把 from 行移动到 to 位（原始下标语义；拖拽细节由 drag.ts 收敛）。 */
	const moveProvider = (from: number, to: number) => {
		const ids = orderedRoutes.map((route) => route.provider)
		const [moved] = ids.splice(from, 1)
		ids.splice(to, 0, moved)
		setProviderOrder(ids)
		try {
			window.localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(ids))
		} catch {
			// 本地存储不可用（隐私模式等）时顺序仅本次会话生效。
		}
	}
	const providerDrag = useRowDragReorder(moveProvider)

	return (
		<div className={styles.panel}>
			<header className={styles.panelHead}>
				<div>
					<h2 className={styles.panelTitle}>模型目录</h2>
					<p className={styles.panelSubtitle}>
						浏览 models.dev 并写入 <code className={styles.code}>llm-pi-ai</code>
						；点「编辑」在弹窗中编辑该 Provider。
					</p>
				</div>
				<div className={styles.actions}>
					<Button variant="outline" onClick={() => setCreating(true)}>
						新建 Provider
					</Button>
				</div>
			</header>

			{!writable ? <div className={styles.notice}>当前 Settings Provider 不可写，面板为只读。</div> : null}
			{state.error ? <div className={styles.error}>{state.error}</div> : null}
			{/* 写入成功等一次性提示走官方 Toast：淡出后由 dismissNotice 清空 store。 */}
			{state.notice !== null ? (
				<Toast
					key={state.notice}
					text={state.notice}
					holdMs={5000}
					onDone={() => props.store.dismissNotice()}
				/>
			) : null}
			{state.status === 'loading' ? <div className={styles.loading}>正在读取 llm-pi-ai 配置…</div> : null}

			<div className={styles.routes}>
				{orderedRoutes.map((route, index) => (
					<RouteRow
						key={route.provider}
						route={route}
						busy={busyProvider === route.provider}
						onEdit={() => setEditing(route.provider)}
						onDelete={() => setDeleting(route.provider)}
						dragging={providerDrag.isDragging(index)}
						dropLine={providerDrag.lineAt(index, orderedRoutes.length)}
						dragHandlers={providerDrag.rowProps(index, route.provider)}
					/>
				))}
				{routes.length === 0 && state.status === 'ready' ? (
					<div className={styles.empty}>
						还没有配置任何 Provider；点「新建 Provider」开始（使用内置 / 自定义 Provider）。
						{dormant.length > 0 ? `（pi-ai 内置目录里有 ${dormant.length} 个可选 Provider，尚未配置）` : ''}
					</div>
				) : null}
			</div>

			{editingRoute ? (
				<RouteEditor
					key={editingRoute.provider}
					route={editingRoute}
					choices={state.choices}
					catalog={props.store.catalogOf(editingRoute.provider)}
					keyConfigured={keyState[editingRoute.provider]}
					writable={writable}
					busy={busyProvider === editingRoute.provider}
					error={state.error}
					modelsDev={state.modelsDev}
					onLoadModelsDev={() => props.store.ensureModelsDev()}
					onExit={() => setEditing(undefined)}
					onFetchModels={(request) => props.operations.discoverEndpoint(request)}
					onSave={(candidate, apiKey) =>
						props.store.saveRoute(editingRoute.provider, candidate, apiKey === undefined ? {} : { apiKey })
					}
					onDelete={async () => {
						await props.store.deleteProvider(editingRoute.provider)
						setEditing(undefined)
					}}
				/>
			) : null}

			{deleting !== undefined ? (
				<ConfirmDialog
					title={`删除 Provider ${deleting}`}
					body="只删除 llm-pi-ai 用户层里的这条 profile（凭据与组合层配置保留）。"
					confirmLabel="删除"
					busy={busyProvider !== null}
					onCancel={() => setDeleting(undefined)}
					onConfirm={() => {
						void props.store.deleteProvider(deleting).then(() => setDeleting(undefined))
					}}
				/>
			) : null}

			{creating ? (
				<CreateProviderDialog
					busy={busyProvider !== null}
					error={state.error}
					knownProviders={routes.map((route) => route.provider)}
					dormantProviders={dormant.map((route) => route.provider)}
					catalog={state.modelsDev}
					modelsDevLoading={state.modelsDevLoading}
					modelsDevError={state.modelsDevError}
					routes={routes}
					onCancel={() => setCreating(false)}
					onLoadCatalog={() => void props.store.ensureModelsDev()}
					onCreate={(provider, profile, apiKey) => {
						void props.store.createProvider(provider, profile, apiKey === undefined ? {} : { apiKey })
						setCreating(false)
					}}
					onSaveProfile={(provider, profile, notice, apiKey) =>
						props.store.createProvider(provider, profile, apiKey === undefined ? {} : { apiKey })
					}
					onFetchModels={(request) => props.operations.discoverEndpoint(request)}
					onError={(message) => props.store.fail(message)}
				/>
			) : null}
		</div>
	)
}
