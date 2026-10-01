import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的词典命名空间：注册进宿主 locale 服务，语言选择与回退由其统一裁决。 */
export const NS = 'dsh-notify'

export type NotifyT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  'notify.turn': '模型处理已完成',
  'notify.question': '等待您的回答',
  'notify.approval': '等待您的批准',
  'detail.planReview': '等待计划审批',
  'detail.questionFallback': '等待您的回答',
  'detail.questionCount': '{first} 等 {count} 个问题',
  'detail.approval': '等待批准：{tool}',
  'detail.tool': '工具',
  'detail.approvalSuffix': '{base} · {reason}',
  'session.fallback': '会话 {id}',
  'panel.desc':
    '当主代理会话的模型回合处理完成、模型发起提问（含计划审批）等待您回答、或工具操作等待您批准时，通过浏览器 Notification API 发送系统级桌面通知，点击通知可聚焦回本页面。事件经宿主 Remote 通道实时转发，无轮询；需要本页面保持打开（关闭期间的事件无接收方、不会补发，仍在等待的提问/审批会在页面重开后补通知）。首次使用请先授予通知权限。您正在浏览本页（标签页可见且窗口聚焦）时不弹通知；这类事件约 3 秒后复查一次——届时已切走则补弹，仍在浏览则静默。',
  'panel.switchTitle': '完成通知',
  'panel.test': '测试',
  'panel.testTitle': 'DSH · 测试通知',
  'panel.requesting': '请求中…',
  'panel.requestPermission': '请求通知权限',
  'panel.enabled': '通知：开',
  'panel.disabled': '通知：关',
  'permission.unsupported': '浏览器不支持',
  'permission.default': '未授权',
  'permission.granted': '已授权',
  'permission.denied': '已被拒绝',
} as const

export type NotifyKey = keyof typeof zh

export const en: { [Key in NotifyKey]: string } = {
  'notify.turn': 'The model finished processing',
  'notify.question': 'Waiting for your answer',
  'notify.approval': 'Waiting for your approval',
  'detail.planReview': 'Waiting for plan review',
  'detail.questionFallback': 'Waiting for your answer',
  'detail.questionCount': '{first} and {count} more questions',
  'detail.approval': 'Waiting for approval: {tool}',
  'detail.tool': 'tool',
  'detail.approvalSuffix': '{base} · {reason}',
  'session.fallback': 'Session {id}',
  'panel.desc':
    'Sends a system desktop notification through the browser Notification API when a main-agent session finishes a model turn, asks a question (including plan review), or waits for a tool approval. Clicking the notification focuses this page. Events arrive live over the host Remote channel with no polling; this page must stay open (events during closure have no receiver and are not replayed, though pending questions/approvals re-notify once the page reopens). Grant notification permission before first use. No notification fires while you are viewing this page (tab visible and window focused); such events are re-checked after about 3 seconds — fired late if you have left, dropped silently if not.',
  'panel.switchTitle': 'Completion notifications',
  'panel.test': 'Test',
  'panel.testTitle': 'DSH · Test notification',
  'panel.requesting': 'Requesting…',
  'panel.requestPermission': 'Request notification permission',
  'panel.enabled': 'Notifications: on',
  'panel.disabled': 'Notifications: off',
  'permission.unsupported': 'Unsupported browser',
  'permission.default': 'Not granted',
  'permission.granted': 'Granted',
  'permission.denied': 'Denied',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-notify': NotifyKey
  }
}
