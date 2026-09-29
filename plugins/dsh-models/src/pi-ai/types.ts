// 面板读写的对象是 raw user settings 层：Entry 类型从官方
// @deepseek-ai/dsh-llm-pi-ai 的 Profile 派生（字段语义归官方），差异仅有
// 三点——compat 保持不透明（面板从 schema envelope 内省选项，见
// choices.ts）、集合改 readonly、索引签名允许未知字段原样往返。
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
