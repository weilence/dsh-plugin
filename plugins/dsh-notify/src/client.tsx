// dsh-notify — client half（React + TSX + CSS Modules）。
// 产物 lib/client.js 由 tsdown 生成，勿直接编辑。react / react-dom 来自宿主
// platform seed table（CLIENT_EXTERNALS），编译后样式内联，factory 执行时以
// <style data-plugin-css> 注入。
//
// ── 架构（纯 client，无自建传输）──────────────────────────────────────────
// 1) 回合完成：ctx.remote.$on('api-session/status') 直接订阅宿主转发的
//    emit 事件（API_REMOTE_FORWARDED_EVENTS 白名单内），running 归还 false
//    即本回合处理完成，几乎零延迟且无轮询；
// 2) 提问 / 审批等待：订阅 ctx.uiSession.sessionStatus（公开 observable，
//    汇聚 running、pendingInteraction、completionUnread）。官方 UI 插件
//    （ui-user-questions / ui-approval）收到转发的 waterfall 事件时会同步
//    注册 pending interaction，快照随之更新；对快照做按 key 的 diff，新增
//    pendingInteraction 即触发「等待回答 / 等待批准」通知。
//
//    为什么不直接 $on 这两个 waterfall 事件：waterfall 监听器按注册顺序
//    串行执行，官方 UI 的监听器会阻塞到用户作答才返回（return await
//    pending.result）；第三方插件加载在官方 UI 之后（host composition 行序
//    → 浏览器名录行序），其监听器排在链尾，正常作答路径下永远不会被调用
//    （next() 仅在官方监听器弃权时才向后传递）。sessionStatus 是这些事件
//    的公开汇聚点，注册 pending interaction 与事件到达同一 tick，语义等价
//    且不受加载顺序影响。
//
// 3) 会话标题：ctx.sessions.list 快照的 displayTitle（durable title →
//    工作区目录名 → sessionId 回退），缺席时回退「会话 + id 前 8 位」。
//
// 状态与决策：唯一共享可变状态是模块级总开关 notifyEnabled（面板写、
// notify 读）；前台浏览静默为固定行为（逐事件采样）；权限事实源在浏览器，
// showNotification 活读，不做镜像。
//
// 投递语义：转发事件为 best-effort、不回放——页面关闭期间的事件没有
// 接收方，连接闪断期间的 emit 事件会丢失；仍在等待的 waterfall 会在重连
// 后回放，因此提问/审批等待在页面重开时仍会补通知一次。
//
// 首次激活时若权限为 default 会主动请求一次（页面已有用户激活记录，
// Chromium 系浏览器允许非手势触发）；其余浏览器用面板按钮手动请求。

// ── 宿主契约类型（官方包 type-only 导入，构建产物零运行时导入）─────────────
// cordis Context 经下列声明合并获得各服务：
//   ctx.remote        ← @deepseek-ai/dsh-api-remotes/client（$on 键面 + 载荷）
//   ctx.uiSession     ← @deepseek-ai/dsh-client-ui-session/client
//   ctx.sessions      ← @deepseek-ai/dsh-api-session-controller/client
//   ctx.uiWorkspace   ← @deepseek-ai/dsh-client-ui-workspace/client（openSession）
//   ctx.slots         ← @deepseek-ai/dsh-client-ui-renderer/client
// settings.section 槽位契约 ← @deepseek-ai/dsh-client-ui-settings/client

import { useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：ctx.remote（ClientRemote）的 Context 合并 + 转发事件键面。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only：ctx.uiSession（UiSession）的 Context 合并 + sessionStatus 类型。
import type { SessionPendingInteractionBase, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only：ctx.sessions（ISessions）的 Context 合并。
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only：ctx.uiWorkspace（openSession 导航）的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only：ctx.slots（SlotRegistry）的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only：settings.section 的 SlotMap 合并（设置页槽位契约）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import styles from './client.module.css'

// ── 领域类型与总开关 ────────────────────────────────────────────────────────

type PermissionState = 'unsupported' | 'default' | 'granted' | 'denied'
type NotifyKind = 'turn' | 'question' | 'approval'

// 唯一共享的可变状态：设置面板写、notify 读。面板是唯一读者，按钮文案刷新
// 用组件局部 state（挂载时取当前值），无需跨组件订阅机制。
let notifyEnabled = true

// ── 通知权限 ────────────────────────────────────────────────────────────────

// 面板挂载时读取；浏览器是唯一事实源，事件路径在 showNotification 活读。
const readPermission = (): PermissionState =>
	typeof Notification === 'undefined' ? 'unsupported' : (Notification.permission as PermissionState)

// Promise 形态：现代浏览器（Safari 13+ / Chrome / Firefox / Edge）全覆盖。
async function requestPermission(): Promise<PermissionState> {
	if (typeof Notification === 'undefined') return 'unsupported'
	try {
		return String(await Notification.requestPermission()) as PermissionState
	} catch {
		return Notification.permission as PermissionState
	}
}

// ── 前台浏览判定（固定静默行为的依据）─────────────────────────────────────

// 标签页可见且窗口聚焦 = 用户正盯着本页；浏览器无法可靠感知窗口遮挡。
const isPageViewing = (): boolean =>
	document.visibilityState === 'visible' && document.hasFocus()

// ── 系统通知原语（权限活读；「测试」按钮直达，绕过开关与前台静默）─────────

function showNotification(title: string, body: string, onClick?: () => void): void {
	console.info('[dsh-notify] show entry, permission=', typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
	// 不带 tag：Windows/Chromium 的 tag 语义是同 tag 静默替换——首个通知被
	// 收进中心后，同 tag 的后续通知只原地更新条目、不再弹横幅，表现为
	// 「再也没有通知」。去掉 tag 让每次通知都是全新 toast。
	try {
		const notification = new Notification(title, { body })
		notification.onclick = () => {
			window.focus()
			onClick?.()
			notification.close()
			// desktop：请求插件 host half 恢复窗口（host 以干净环境 spawn
			// dsh://open 协议 → 宿主 focusPrimaryWindow，与托盘「打开」同路）。
			// 仅 desktop 页面（dsh-app: origin）发送——Web 宿主上浏览器点击
			// 通知自带应用激活，无需此请求；自定义头让跨站 POST 折在 CORS 预检。
			if (location.protocol === 'dsh-app:') {
				void fetch('/dsh-notify/activate', { method: 'POST', headers: { 'x-dsh-notify': '1' } })
					.catch(() => {})
			}
		}
		notification.onshow = () => { console.info('[dsh-notify] shown:', title) }
		notification.onerror = (event) => { console.info('[dsh-notify] onerror:', title, event) }
	} catch (error) {
		console.error('[dsh-notify] show notification failed', error)
	}
}

// ── 纯函数（导出仅为单测）────────────────────────────────────────────────

// 提问事件的通知正文：单题取问题文本（超长截断），多题汇总数量；
// 无法提取时回退通用文案。运行时防御保留：载荷来自宿主，可能与编译时
// 类型声明存在版本偏差。
export function questionDetail(questions: readonly AskUserQuestionItem[] | undefined): string {
	const list = Array.isArray(questions) ? questions : []
	const texts: string[] = []
	for (const item of list) {
		if (item == null || typeof item !== 'object') continue
		if (item.intent?.kind === 'plan-review') {
			texts.push('等待计划审批')
			continue
		}
		const text = item.question
		if (typeof text === 'string' && text.trim().length > 0) texts.push(text.trim())
	}
	if (texts.length === 0) return '等待您的回答'
	const first = texts[0].length > 120 ? texts[0].slice(0, 120) + '…' : texts[0]
	return list.length > 1 ? `${first} 等 ${list.length} 个问题` : first
}

// 审批事件的通知正文：工具名 + 审批人给出的原因（截断）；无法提取时回退。
export function approvalDetail(toolName: string | undefined, reason: string | undefined): string {
	const tool =
		typeof toolName === 'string' && toolName.trim().length > 0 ? toolName.trim() : '工具'
	const base = `等待批准：${tool}`
	const text = typeof reason === 'string' ? reason.trim() : ''
	if (text.length === 0) return base
	return `${base} · ${text.length > 120 ? text.slice(0, 120) + '…' : text}`
}

// pending interaction 的通知正文。SessionPendingInteractionMap 的具名子类
// （PendingQuestion / PendingApproval）由官方 UI 包声明合并——本包不导入
// 它们，按 Base 类型收参、结构化取字段，保持零额外依赖与版本容差。
export function interactionDetail(interaction: SessionPendingInteractionBase): string {
	const extra = interaction as SessionPendingInteractionBase & {
		readonly questions?: unknown
		readonly toolName?: unknown
		readonly reason?: unknown
	}
	if (interaction.kind === 'plan-review') return '等待计划审批'
	if (interaction.kind === 'approval') {
		return approvalDetail(
			extra.toolName as string | undefined,
			extra.reason as string | undefined,
		)
	}
	return questionDetail(extra.questions as readonly AskUserQuestionItem[] | undefined)
}

// ── 事件 → 通知 ────────────────────────────────────────────────────────────

// 会话标题：sessions.list 快照的 displayTitle（durable title → 工作区目录名
// → id 回退由官方服务完成），缺席时回退「会话 + id 前 8 位」。防御式读取，
// 容忍与类型声明的版本偏差。
function titleOf(ctx: ClientContext, sessionId: string): string {
	try {
		const title = ctx.sessions.list.getSnapshot().byId[sessionId as SessionId]?.displayTitle
		if (typeof title === 'string' && title.length > 0) return title
	} catch {}
	return '会话 ' + String(sessionId).slice(0, 8)
}

// 事件路径的完整决策：总开关 + 前台静默（固定行为、逐事件采样）；权限由
// showNotification 活读。设置面板的「测试」按钮绕过本函数直达原语——用户
// 点击测试时必然正在浏览本页，不该被静默挡住。
// 完成瞬间可能恰逢用户正在离开（最小化/切窗途中）：静默命中时 3 秒后
// 复查一次，届时已离开则补弹，仍在浏览则放弃。
function notify(ctx: ClientContext, sessionId: string, kind: NotifyKind, detail?: string): void {
	if (!notifyEnabled) return
	const viewing = isPageViewing()
	console.info('[dsh-notify] event', kind, 'viewing=' + String(viewing))
	const fire = (): void => {
		const body = kind === 'question' ? detail || '等待您的回答'
			: kind === 'approval' ? detail || '等待您的批准'
			: '模型处理已完成'
		// 点击通知：聚焦页面（web 宿主有效；desktop 的 renderer
		// window.focus() 无法恢复最小化窗口，需宿主侧桥接）并切换到
		// 对应会话——desktop 上用户手动恢复窗口时即已停在正确会话。
		showNotification('DSH · ' + titleOf(ctx, sessionId), body, () => {
			try {
				ctx.uiWorkspace.openSession(sessionId as SessionId)
			} catch (error) {
				console.error('[dsh-notify] open session failed', error)
			}
		})
	}
	if (viewing) {
		window.setTimeout(() => {
			if (!notifyEnabled || isPageViewing()) return
			console.info('[dsh-notify] deferred fire', kind)
			fire()
		}, 3000)
		return
	}
	fire()
}

// ── 展示：设置页面板 ─────────────────────────────────────────────────────

const CHIP: Record<PermissionState, { text: string; tone: 'ok' | 'warn' | 'err' }> = {
	unsupported: { text: '浏览器不支持', tone: 'err' },
	default: { text: '未授权', tone: 'warn' },
	granted: { text: '已授权', tone: 'ok' },
	denied: { text: '已被拒绝', tone: 'err' },
}

const TONE_CLASS: Record<'ok' | 'warn' | 'err', string> = {
	ok: styles.chipOk,
	warn: styles.chipWarn,
	err: styles.chipErr,
}

function NotifyPanel() {
	const [permission, setPermission] = useState<PermissionState>(readPermission)
	const [busy, setBusy] = useState(false)
	// 面板挂载时取模块级开关的当前值；点击时两处同步写。
	const [enabled, setEnabled] = useState(() => notifyEnabled)

	const chip = CHIP[permission]
	const chipClass = styles.chip + ' ' + TONE_CLASS[chip.tone]

	const onToggle = (): void => {
		notifyEnabled = !notifyEnabled
		setEnabled(notifyEnabled)
	}

	const onRequest = async (): Promise<void> => {
		setBusy(true)
		try {
			setPermission(await requestPermission())
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className={styles.panel}>
			<p className={styles.desc}>
				当任意会话（含子代理）的模型回合处理完成、模型发起提问（含计划审批）
				等待您回答、或工具操作等待您批准时，通过浏览器 Notification API 发送
				系统级桌面通知，点击通知可聚焦回本页面。事件经宿主 Remote 通道实时
				转发，无轮询；需要本页面保持打开（关闭期间的事件无接收方、不会补发，
				仍在等待的提问/审批会在页面重开后补通知）。首次使用请先授予通知
				权限。您正停留在本页（标签页可见且聚焦）时不弹通知，切走标签页或
				最小化后自动恢复。
			</p>
			<div className={styles.row}>
				<span className={styles.title}>完成通知</span>
				<span className={chipClass} role="status">{chip.text}</span>
			</div>
			<div className={styles.row}>
				{permission === 'default' && (
					<button
						type="button"
						className={styles.button}
						disabled={busy}
						onClick={() => { void onRequest() }}
					>
						{busy ? '请求中…' : '请求通知权限'}
					</button>
				)}
				<button
					type="button"
					className={styles.button}
					onClick={onToggle}
				>
					{enabled ? '通知：开' : '通知：关'}
				</button>
				<button
					type="button"
					className={styles.button}
					onClick={() => { showNotification('DSH · 测试通知', '模型处理已完成') }}
				>
					测试
				</button>
			</div>
		</div>
	)
}

// ── 插槽接线 ─────────────────────────────────────────────────────────────

export const inject: string[] = ['remote', 'sessions', 'uiSession', 'uiWorkspace', 'slots']

export function apply(ctx: ClientContext) {
	// 首次激活主动请求一次权限（best effort；仅 default 状态）。结果无需
	// 回写——权限事实源在浏览器，事件路径与面板挂载都活读。
	if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
		void requestPermission()
	}

	// 事件订阅归属插件 fiber，卸载时自动退订。
	ctx.effect(() => {
		// 1) 回合完成：转发的 api-session/status（emit，订阅即收，无链式语义）。
		const disposeStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
			console.info('[dsh-notify] status', String(sessionId).slice(0, 8), String(running))
			if (running !== false) return
			notify(ctx, sessionId, 'turn')
		})

		// 2) 提问 / 审批等待：diff uiSession.sessionStatus 的 pendingInteraction。
		//    基线取订阅时刻快照——加载前已存在的等待不回放通知；此后新增 key
		//    （新提问、新审批或替换请求）即通知，消失（已回答/已批准）不通知。
		let baseline: SessionStatusSnapshot = ctx.uiSession.sessionStatus.getSnapshot()
		const disposePending = ctx.uiSession.sessionStatus.subscribe(() => {
			const next = ctx.uiSession.sessionStatus.getSnapshot()
			for (const [sessionId, status] of next) {
				const pending = status.pendingInteraction
				if (pending === undefined) continue
				if (baseline.get(sessionId)?.pendingInteraction?.key === pending.key) continue
				notify(
					ctx,
					sessionId,
					pending.kind === 'approval' ? 'approval' : 'question',
					interactionDetail(pending),
				)
			}
			baseline = next
		})

		return () => {
			disposeStatus()
			disposePending()
		}
	}, 'dsh-notify: remote event subscriptions')

	// 设置面板独立「完成通知」菜单页。
	ctx.slots.inject('settings.section', () => {
		return ctx.slots.register(
			{ name: 'settings.section', id: 'dsh-notify', order: 50, label: '完成通知' },
			NotifyPanel,
		)
	})
}
