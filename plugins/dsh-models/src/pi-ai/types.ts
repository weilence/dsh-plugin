import type {
  PiAiModality,
  PiAiModelProfile,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
} from '@deepseek-ai/dsh-llm-pi-ai'

export type { PiAiModality, PiAiReasoningEfforts } from '@deepseek-ai/dsh-llm-pi-ai'

export type ThinkingLevel = keyof PiAiReasoningEfforts

// 完备性锁：官方 PiAiReasoningEfforts 新增/删减等级时，这个键全集字面量在此编译期报错；键序即展示序（沿用官方升级序）。
const THINKING_LEVEL_FLAGS = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} as const satisfies Record<ThinkingLevel, true>

export const THINKING_LEVELS: readonly ThinkingLevel[] = Object.keys(THINKING_LEVEL_FLAGS) as ThinkingLevel[]

// pi-ai 0.85.1 安装目录核实：这些 provider 的目录模型横跨多种协议。官方配
// 置面没有模型级 api、route 级 api 又会覆盖全部目录模型、目录共用协议也不
// 存在——目录外模型在它们的 route 上无法写入。复核方法：扫
// @earendil-works/pi-ai 的 providers/data/*.json，顶层协议键多于一个即入表。
export const MIXED_PROTOCOL_PROVIDERS: readonly string[] = [
  'cloudflare-ai-gateway',
  'fireworks',
  'github-copilot',
  'opencode',
  'opencode-go',
  'openrouter',
]

// 从官方 Profile 派生的 raw user settings 层投影（字段语义归官方），差异仅：
// compat 不透明（面板经 schema envelope 内省，见 choices.ts）、集合改
// readonly、索引签名允许未知字段原样往返。
export interface PiAiModelEntry extends Omit<PiAiModelProfile, 'input' | 'compat'> {
  input?: readonly PiAiModality[]
  compat?: Readonly<Record<string, unknown>>
  [key: string]: unknown
}

export interface PiAiProviderEntry extends Omit<PiAiProviderProfile, 'models' | 'modelOverrides' | 'compat'> {
  models?: readonly PiAiModelEntry[]
  modelOverrides?: Readonly<Record<string, PiAiModelEntry>>
  compat?: Readonly<Record<string, unknown>>
  [key: string]: unknown
}

export type RouteSource =
  /** 安装目录 route，用户层未声明模型 → 单模型编辑写 modelOverrides。 */
  | 'inherited'
  /** 安装目录 route，用户层有 modelOverrides → 单模型编辑写 modelOverrides。 */
  | 'overridden'
  /** 用户层有非空 models → 整表编辑。 */
  | 'explicit'
  /** pi-ai 不提供的 route，必须自带 api/baseURL/models。 */
  | 'declared'
