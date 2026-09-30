/** 有用量适配器的 Provider id 注册表；展示名按宿主语言在 client half 渲染。 */
export const USAGE_PROVIDERS = ['zai-coding-cn', 'openai-codex', 'github-copilot'] as const

export type UsageProviderId = (typeof USAGE_PROVIDERS)[number]

/** 窗口标签的语义事实：host 只描述窗口是什么，文案由 client 按宿主语言渲染。 */
export type UsageWindowLabel =
  | {
      kind: 'window'
      /** 窗口时长（分钟）；300 与 10080 有专名，其余按分钟显示，缺失时回退角色名。 */
      windowMins: number | null
      /** 时长缺失时的角色名（Codex 主/次窗口）。 */
      role?: 'primary' | 'secondary'
      /** 附加额度桶名称（原样展示的标识符，两种语言同形）。 */
      bucketName?: string
    }
  | { kind: 'toolCalls' }
  /** Copilot 套餐的高级请求额度窗口。 */
  | { kind: 'premiumRequests' }
  | { kind: 'text'; text: string }

export interface UsageWindow {
  id: string
  label: UsageWindowLabel
  usedPct: number | null
  resetMs: number | null
  /** 套餐额度的剩余量与总量，二者齐全才显示（Copilot 私有接口）。 */
  remaining?: number | null
  entitlement?: number | null
  /** 无限额度：不显示百分比与余额，进度条拉满。 */
  unlimited?: boolean
}

export type ProviderUsage =
  | {
      kind: 'quota'
      provider: 'zai-coding-cn' | 'openai-codex' | 'github-copilot'
      windows: UsageWindow[]
      queriedAt: number
    }
  | {
      kind: 'unavailable'
      provider: string
      /**
       * 稳定失败原因码：client 按宿主语言翻译摘要；host 不预写界面文案。
       * unknown 表示无法分类，此时 detail 就是主文案，原样展示。
       */
      code: UsageFailureCode
      /** 安全的原始技术详情（已脱敏）；与摘要并存，可选中复制。 */
      detail: string
    }

/** 用量查询的可识别失败：跨 Host↔Client 传输的语义事实，文案由 client 翻译。 */
export type UsageFailureCode =
  'not_configured' | 'not_signed_in' | 'unsupported_account' | 'authorization_changed' | 'unknown'

/** Host 侧已分类的用量失败：抛出点携带稳定 code，message 是安全详情。 */
export class UsageError extends Error {
  constructor(
    readonly code: UsageFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'UsageError'
  }
}
