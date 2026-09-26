import { useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ToneChip } from '@dsh-plugins/client-ui/tone'
// Type-only：ctx.remote / ctx.uiSession / ctx.sessions / ctx.uiWorkspace /
// ctx.slots 与 settings.section 槽位的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { interactionDetail } from './detail'
import styles from './client.module.css'

type PermissionState = 'unsupported' | 'default' | 'granted' | 'denied'
type NotifyKind = 'turn' | 'question' | 'approval'

// 唯一共享的可变状态：设置面板写、notify 读；面板是唯一读者，按钮文案刷新
// 用组件局部 state，无需跨组件订阅机制。
let notifyEnabled = true

// 权限事实源在浏览器，事件路径在 showNotification 活读。
const readPermission = (): PermissionState =>
  typeof Notification === 'undefined' ? 'unsupported' : (Notification.permission as PermissionState)

async function requestPermission(): Promise<PermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return String(await Notification.requestPermission()) as PermissionState
  } catch {
    return Notification.permission as PermissionState
  }
}

// 标签页可见且窗口聚焦 = 用户正盯着本页；浏览器无法可靠感知窗口遮挡。
const isPageViewing = (): boolean => document.visibilityState === 'visible' && document.hasFocus()

function showNotification(title: string, body: string, onClick?: () => void): void {
  console.info(
    '[dsh-notify] show entry, permission=',
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  // 不带 tag：Windows/Chromium 的同 tag 通知只原地更新不再弹横幅，表现为
  // 「再也没有通知」，去掉 tag 让每次通知都是全新 toast。
  try {
    const notification = new Notification(title, { body })
    notification.onclick = () => {
      window.focus()
      onClick?.()
      notification.close()
      // desktop（dsh-app: origin）请求 host half 恢复窗口；Web 宿主上浏览器
      // 点击通知自带应用激活，自定义头让跨站 POST 折在 CORS 预检。
      if (location.protocol === 'dsh-app:') {
        void fetch('/dsh-notify/activate', { method: 'POST', headers: { 'x-dsh-notify': '1' } }).catch(
          () => {},
        )
      }
    }
    notification.onshow = () => {
      console.info('[dsh-notify] shown:', title)
    }
    notification.onerror = (event) => {
      console.info('[dsh-notify] onerror:', title, event)
    }
  } catch (error) {
    console.error('[dsh-notify] show notification failed', error)
  }
}

// 会话标题：sessions.list 快照的 displayTitle；防御式读取，容忍版本偏差。
function titleOf(ctx: ClientContext, sessionId: string): string {
  try {
    const title = ctx.sessions.list.getSnapshot().byId[sessionId as SessionId]?.displayTitle
    if (typeof title === 'string' && title.length > 0) return title
  } catch {}
  return '会话 ' + String(sessionId).slice(0, 8)
}

// 事件路径的完整决策：总开关 + 前台静默；「测试」按钮绕过本函数直达原语。
// 完成瞬间可能恰逢用户正在离开：静默命中时 3 秒后复查一次，届时已离开则
// 补弹，仍在浏览则放弃。
function notify(ctx: ClientContext, sessionId: string, kind: NotifyKind, detail?: string): void {
  if (!notifyEnabled) return
  const viewing = isPageViewing()
  console.info('[dsh-notify] event', kind, 'viewing=' + String(viewing))
  const fire = (): void => {
    const body =
      kind === 'question'
        ? detail || '等待您的回答'
        : kind === 'approval'
          ? detail || '等待您的批准'
          : '模型处理已完成'
    // 点击通知聚焦页面并切换到对应会话（desktop 上 renderer 无法恢复最小化
    // 窗口，由宿主侧桥接）。
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

const CHIP: Record<PermissionState, { text: string; tone: 'ok' | 'warn' | 'err' }> = {
  unsupported: { text: '浏览器不支持', tone: 'err' },
  default: { text: '未授权', tone: 'warn' },
  granted: { text: '已授权', tone: 'ok' },
  denied: { text: '已被拒绝', tone: 'err' },
}

function NotifyPanel() {
  const [permission, setPermission] = useState<PermissionState>(readPermission)
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(() => notifyEnabled)

  const chip = CHIP[permission]

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
        权限。您正停留在本页（标签页可见且聚焦）时不弹通知，切走标签页或 最小化后自动恢复。
      </p>
      <div className={styles.row}>
        <span className={styles.title}>完成通知</span>
        <ToneChip tone={chip.tone}>{chip.text}</ToneChip>
      </div>
      <div className={styles.row}>
        {permission === 'default' && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              void onRequest()
            }}
          >
            {busy ? '请求中…' : '请求通知权限'}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onToggle}>
          {enabled ? '通知：开' : '通知：关'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            showNotification('DSH · 测试通知', '模型处理已完成')
          }}
        >
          测试
        </Button>
      </div>
    </div>
  )
}

export const inject: string[] = ['remote', 'sessions', 'uiSession', 'uiWorkspace', 'slots']

export function apply(ctx: ClientContext) {
  // 首次激活主动请求一次权限（best effort；仅 default 状态），结果无需回写。
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    void requestPermission()
  }

  // 事件订阅归属插件 fiber，卸载时自动退订。
  ctx.effect(() => {
    // 1) 回合完成：转发的 api-session/status（emit，订阅即收，无链式语义）。
    //    转发事件 best-effort 不回放（页面关闭期间没有接收方），仍在等待的
    //    waterfall 重连后会回放，页面重开时补通知一次。
    const disposeStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
      console.info('[dsh-notify] status', String(sessionId).slice(0, 8), String(running))
      if (running !== false) return
      notify(ctx, sessionId, 'turn')
    })

    // 2) 提问 / 审批等待：diff sessionStatus 的 pendingInteraction——不直接
    //    $on waterfall 事件：官方 UI 的监听器会阻塞到用户作答才返回，第三方
    //    插件的监听器排在链尾、正常作答路径下永远不会被调用，sessionStatus
    //    是这些事件的公开汇聚点且不受加载顺序影响；基线取订阅时刻快照
    //    （加载前已存在的等待不回放通知），此后新增 key 即通知。
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

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      { name: 'settings.section', id: 'dsh-notify', order: 50, label: '完成通知' },
      NotifyPanel,
    )
  })
}
