import { useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ToneChip } from '@dsh-plugins/client-ui/tone'
// Type-only：ctx.remote / ctx.uiSession / ctx.sessions / ctx.uiWorkspace /
// ctx.slots / ctx.locale 与 plugins.bundle.config 槽位的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { interactionDetail } from './detail'
import { NS, en, zh, type NotifyT } from './client/locales'
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

// 标签页可见且窗口聚焦 = 用户正在查看本页；浏览器无法可靠感知窗口遮挡。
const isPageViewing = (): boolean => document.visibilityState === 'visible' && document.hasFocus()

function showNotification(title: string, body: string, onClick?: () => void): void {
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
  } catch (error) {
    console.error('[dsh-notify] show notification failed', error)
  }
}

// 会话标题：sessions.list 快照的 displayTitle；防御式读取，容忍版本偏差。
function titleOf(ctx: ClientContext, sessionId: string, t: NotifyT): string {
  try {
    const title = ctx.sessions.list.getSnapshot().byId[sessionId as SessionId]?.displayTitle
    if (typeof title === 'string' && title.length > 0) return title
  } catch {}
  return t('session.fallback', { id: String(sessionId).slice(0, 8) })
}

// 事件路径的完整决策：总开关 + 前台静默；「测试」按钮绕过本函数直达原语。
// 完成瞬间可能恰逢用户正在离开：静默命中时 3 秒后复查一次，届时已离开则
// 补弹，仍在浏览则放弃。
function notify(ctx: ClientContext, t: NotifyT, sessionId: string, kind: NotifyKind, detail?: string): void {
  if (!notifyEnabled) return
  const id = sessionId as SessionId
  const session = ctx.sessions.list.getSnapshot().byId[id]
  // 未知会话不能证明是主代理；parentId 也可能只是普通分叉，须以子代理来源/地址判断。
  if (!session || session.origin === 'subagent' || ctx.sessions.subagentAddress(id)) return
  const viewing = isPageViewing()
  const fire = (): void => {
    // 通知在投递瞬间取词：桌面通知是一次性载体，不随语言切换重渲染。
    const body =
      kind === 'question'
        ? detail || t('notify.question')
        : kind === 'approval'
          ? detail || t('notify.approval')
          : t('notify.turn')
    // 点击通知聚焦页面并切换到对应会话（desktop 上 renderer 无法恢复最小化
    // 窗口，由宿主侧代为恢复）。
    showNotification('DSH · ' + titleOf(ctx, sessionId, t), body, () => {
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
      fire()
    }, 3000)
    return
  }
  fire()
}

/** 完整组件 props：运行时份额 + locale 标准 seat（本面板无注入面）。 */
type NotifySectionProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<typeof NS>

function NotifySection({ t }: NotifySectionProps) {
  const [permission, setPermission] = useState<PermissionState>(readPermission)
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(() => notifyEnabled)

  const chip = {
    unsupported: { text: t('permission.unsupported'), tone: 'err' as const },
    default: { text: t('permission.default'), tone: 'warn' as const },
    granted: { text: t('permission.granted'), tone: 'ok' as const },
    denied: { text: t('permission.denied'), tone: 'err' as const },
  }[permission]

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
      <p className={styles.desc}>{t('panel.desc')}</p>
      <div className={styles.row}>
        <span className={styles.title}>{t('panel.switchTitle')}</span>
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
            {busy ? t('panel.requesting') : t('panel.requestPermission')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onToggle}>
          {enabled ? t('panel.enabled') : t('panel.disabled')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            showNotification(t('panel.testTitle'), t('notify.turn'))
          }}
        >
          {t('panel.test')}
        </Button>
      </div>
    </div>
  )
}

export const inject: string[] = ['remote', 'sessions', 'uiSession', 'uiWorkspace', 'slots', 'locale']

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-notify: copy dictionaries')
  const t = ctx.locale.bind(NS)

  // 首次激活主动请求一次权限（best effort；仅 default 状态），结果无需回写。
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    void requestPermission()
  }

  // 事件订阅归属插件 fiber，卸载时自动退订。
  ctx.effect(() => {
    // 回合完成走转发的 api-session/status：emit 语义订阅即收，不像 waterfall 监听器会阻塞到用户作答。
    const disposeStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
      if (running !== false) return
      notify(ctx, t, sessionId, 'turn')
    })

    // 提问/审批不直接 $on waterfall 事件：官方 UI 的监听器阻塞到用户作答才返回、第三方排在链尾收不到，sessionStatus 才是公开汇聚点；基线取订阅时刻快照（已存在的等待不回放），此后新增 key 即通知。
    let baseline: SessionStatusSnapshot = ctx.uiSession.sessionStatus.getSnapshot()
    const disposePending = ctx.uiSession.sessionStatus.subscribe(() => {
      const next = ctx.uiSession.sessionStatus.getSnapshot()
      for (const [sessionId, status] of next) {
        const pending = status.pendingInteraction
        if (pending === undefined) continue
        if (baseline.get(sessionId)?.pendingInteraction?.key === pending.key) continue
        notify(
          ctx,
          t,
          sessionId,
          pending.kind === 'approval' ? 'approval' : 'question',
          interactionDetail(t, pending),
        )
      }
      baseline = next
    })

    return () => {
      disposeStatus()
      disposePending()
    }
  }, 'dsh-notify: remote event subscriptions')

  // 面板挂自家 bundle 详情页（keyed by 包名）：装了插件点开卡片即见面板，
  // 不再占设置页一级导航。
  ctx.slots.inject('plugins.bundle.config', () => {
    return ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: '@weilence/dsh-notify',
        locale: NS,
      },
      NotifySection,
    )
  })
}
