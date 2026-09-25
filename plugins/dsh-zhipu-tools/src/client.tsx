// dsh-zhipu-tools — client half 接线层（React + TSX）。
// 产物 lib/client.js 由 tsdown 生成，勿直接编辑。
//
// 结构：quota-shared.ts（用量数据契约 + 轮询 hook + 换算/格式化纯函数）→
// quota-pill.tsx（行内胶囊触发器 + portal 宿主）与 quota-panel.tsx（浮窗内容）；
// 本文件只做插槽接线：ZhipuQuotaChip 把供应商门控、轮询与胶囊连起来。
//
// react / react-dom / primitives 来自宿主 platform seed table（CLIENT_EXTERNALS），
// clsx 与编译后样式内联，样式在 factory 执行时以 <style data-plugin-css> 注入
// （见 tsdown.config.ts 的 dsh-css-modules-inline）。
//
// 智谱剩余额度胶囊：占据 conversation.input.right 插槽（输入框右区、模型
// 芯片左侧）。插槽定义的 inject(sessionId) 回调由宿主按会话调用并下发
// sessionId（对齐 dsh-client-ui-goal 的用法）；经 ctx.modelDirectories
// 的共享目录读当前生效供应商——current = 持久化选择 → 宿主默认值——
// 仅当供应商为 zai-coding-cn 时显示，隐藏时不轮询。

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useUsageQuota } from './quota-shared'
import { QuotaPill } from './quota-pill'

// ── 宿主契约类型（对注入服务做最小结构化声明）─────────────────────────────

interface SlotDefinition {
	name?: string
	id?: string
	order?: number
	label?: string
	inject?: (sessionId: string) => Record<string, unknown>
}

// model-selection 包的共享目录（宿主内常驻）；结构化声明，缺席时胶囊隐藏。
interface ModelDirectorySnapshotLike {
	status?: string
	current?: { provider?: string; model?: string } | null
}

interface ModelDirectoryLike {
	store: {
		getSnapshot(): ModelDirectorySnapshotLike
		subscribe(listener: () => void): () => void
	}
	load?(): Promise<unknown>
}

interface ModelDirectoriesLike {
	directoryFor(sessionId: string): ModelDirectoryLike
}

interface ClientContext {
	slots: {
		inject(name: string, register: () => unknown): void
		register(definition: SlotDefinition, render: unknown): unknown
	}
	modelDirectories?: ModelDirectoriesLike
	effect(fn: () => unknown, label?: string): unknown
}

// ── 供应商门控：model-selection 共享目录的 current.provider ───────────────

const EMPTY_SNAPSHOT: ModelDirectorySnapshotLike = {}

// 仅当会话当前生效供应商匹配时显示胶囊。
const TARGET_PROVIDER = 'zai-coding-cn'

function useModelProvider(directories: ModelDirectoriesLike | undefined, sessionId: string) {
	const directory = directories?.directoryFor(sessionId)

	// 确保目录装载宿主 catalog（幂等）；装载前 current 为 null，胶囊不显示。
	useEffect(() => {
		void directory?.load?.()?.catch(() => {})
	}, [directory])

	const subscribe = useCallback(
		(listener: () => void) => directory?.store.subscribe(listener) ?? (() => {}),
		[directory],
	)
	const snapshot = useSyncExternalStore(subscribe, () => directory?.store.getSnapshot() ?? EMPTY_SNAPSHOT)
	return snapshot.current?.provider ?? null
}

// ── 插槽接线 ──────────────────────────────────────────────────────────────

interface QuotaChipProps {
	sessionId: string
	directories?: ModelDirectoriesLike
}

// 输入框行内胶囊：仅 zai-coding-cn 会话显示；不显示时不轮询。
function ZhipuQuotaChip(props: QuotaChipProps) {
	const provider = useModelProvider(props.directories, props.sessionId)
	const active = provider === TARGET_PROVIDER
	const { res, refresh } = useUsageQuota(active)

	if (!active) return null
	return <QuotaPill res={res} onForceRefresh={refresh} />
}

export const inject: string[] = ['slots', 'modelDirectories', 'remote.session']

export function apply(ctx: ClientContext) {
	ctx.slots.inject('conversation.input.right', () => {
		return ctx.slots.register(
			{
				name: 'conversation.input.right',
				id: 'zhipu-tools-usage',
				order: 10,
				inject: (sessionId: string) => ({ sessionId, directories: ctx.modelDirectories }),
			},
			ZhipuQuotaChip,
		)
	})
}
