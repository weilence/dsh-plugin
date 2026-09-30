import { THINKING_LEVELS, type PiAiModality, type PiAiReasoningEfforts, type ThinkingLevel } from './types'
import type { PanelMessage } from '../client/locales'

const LEVEL_SET = new Set<string>(THINKING_LEVELS)
const MODALITY_SET = new Set<string>(['text', 'image'])
const THINKING_LEVELS_WITHOUT_OFF = THINKING_LEVELS.filter((level) => level !== 'off')

export interface FieldIssue {
  path: string
  /** 词典消息描述子：渲染期随宿主语言取词，动态片段走插值参数。 */
  message: PanelMessage
}

export function validateProviderReasoning(
  value: string,
  levels: readonly ThinkingLevel[],
): FieldIssue | undefined {
  const effort = value.trim()
  if (effort.length === 0 || levels.some((level) => level === effort)) return undefined
  return {
    path: 'reasoning',
    message: { key: 'validate.unknownDefaultReasoning', params: { effort, levels: levels.join(', ') } },
  }
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return LEVEL_SET.has(value)
}

function isModality(value: string): value is PiAiModality {
  return MODALITY_SET.has(value)
}

// 规则逐条对应官方 resolveModelReasoning() 会在 settings 写入时抛出的拒绝
// 理由；undefined 表示「继承」，false 表示「非推理模型」，两者都合法。
export function validateReasoningEfforts(value: unknown): FieldIssue[] {
  if (value === undefined || value === false) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [{ path: 'reasoningEfforts', message: { key: 'validate.reasoningNotDict' } }]
  }
  const issues: FieldIssue[] = []
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return [
      {
        path: 'reasoningEfforts',
        message: { key: 'validate.reasoningEmptyDict' },
      },
    ]
  }
  for (const [level, wire] of entries) {
    if (!isThinkingLevel(level)) {
      issues.push({
        path: `reasoningEfforts.${level}`,
        message: {
          key: 'validate.unknownReasoning',
          params: { level, levels: THINKING_LEVELS.join(', ') },
        },
      })
      continue
    }
    if (wire === null || wire === undefined) {
      if (level !== 'off') {
        issues.push({
          path: `reasoningEfforts.${level}`,
          message: { key: 'validate.levelWireRequired', params: { level } },
        })
      }
      continue
    }
    if (typeof wire !== 'string') {
      issues.push({
        path: `reasoningEfforts.${level}`,
        message: { key: 'validate.levelWireNotString', params: { level } },
      })
      continue
    }
    if (wire.length === 0) {
      issues.push({
        path: `reasoningEfforts.${level}`,
        message: { key: 'validate.levelWireEmpty', params: { level } },
      })
    }
  }
  if (!THINKING_LEVELS_WITHOUT_OFF.some((level) => Object.hasOwn(value, level))) {
    issues.push({
      path: 'reasoningEfforts',
      message: { key: 'validate.onlyOff' },
    })
  }
  return issues
}

function validatePositiveInteger(value: unknown, path: string): FieldIssue[] {
  if (value === undefined || value === null) return []
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) {
    return [{ path, message: { key: 'validate.positiveInteger', params: { path } } }]
  }
  return []
}

// 省略/空数组都表示「继承」，因此不报错。
function validateInput(value: unknown): FieldIssue[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return [{ path: 'input', message: { key: 'validate.inputNotArray' } }]
  const issues: FieldIssue[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !isModality(item)) {
      issues.push({
        path: 'input',
        message: { key: 'validate.unknownModality', params: { item: String(item) } },
      })
    }
  }
  if (new Set(value).size !== value.length)
    issues.push({ path: 'input', message: { key: 'validate.duplicateModality' } })
  return issues
}

// 面板对一个模型条目的完整字段级校验：把 Host 的拒绝理由前移到保存之前
// （Host 校验仍是最终裁决）。
export function validateModelEntry(entry: {
  id: string
  name?: unknown
  contextWindow?: unknown
  maxTokens?: unknown
  input?: unknown
  reasoningEfforts?: unknown
}): FieldIssue[] {
  const issues: FieldIssue[] = []
  if (!entry.id || typeof entry.id !== 'string')
    issues.push({ path: 'id', message: { key: 'validate.idRequired' } })
  if (entry.name !== undefined && (typeof entry.name !== 'string' || entry.name.length === 0)) {
    issues.push({ path: 'name', message: { key: 'validate.nameNotEmpty' } })
  }
  issues.push(...validatePositiveInteger(entry.contextWindow, 'contextWindow'))
  issues.push(...validatePositiveInteger(entry.maxTokens, 'maxTokens'))
  issues.push(...validateInput(entry.input))
  issues.push(...validateReasoningEfforts(entry.reasoningEfforts))
  return issues
}

export function normalizeReasoningEfforts(
  value: false | Partial<Record<ThinkingLevel, string | null | undefined>> | undefined,
): false | PiAiReasoningEfforts | undefined {
  if (value === undefined || value === false) return value
  const result: PiAiReasoningEfforts = {}
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(value, level)) continue
    const wire = value[level]
    if (wire === undefined) continue
    result[level] = wire
  }
  return result
}
