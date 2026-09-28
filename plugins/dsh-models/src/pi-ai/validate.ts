import { THINKING_LEVELS, type PiAiModality, type PiAiReasoningEfforts, type ThinkingLevel } from './types'

const LEVEL_SET = new Set<string>(THINKING_LEVELS)
const MODALITY_SET = new Set<string>(['text', 'image'])
const THINKING_LEVELS_WITHOUT_OFF = THINKING_LEVELS.filter((level) => level !== 'off')

export interface FieldIssue {
  path: string
  message: string
}

export function validateProviderReasoning(
  value: string,
  levels: readonly ThinkingLevel[],
): FieldIssue | undefined {
  const effort = value.trim()
  if (effort.length === 0 || levels.some((level) => level === effort)) return undefined
  return { path: 'reasoning', message: `未知默认推理等级「${effort}」；可用等级为 ${levels.join(', ')}` }
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
    return [{ path: 'reasoningEfforts', message: 'reasoningEfforts 必须是字典、false，或改回「显示设置」' }]
  }
  const issues: FieldIssue[] = []
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return [
      {
        path: 'reasoningEfforts',
        message: 'reasoningEfforts 不能是空字典；声明提供的等级，改 false 表示非推理模型，或改回「显示设置」',
      },
    ]
  }
  for (const [level, wire] of entries) {
    if (!isThinkingLevel(level)) {
      issues.push({
        path: `reasoningEfforts.${level}`,
        message: `未知推理等级「${level}」；可用等级为 ${THINKING_LEVELS.join(', ')}`,
      })
      continue
    }
    if (wire === null || wire === undefined) {
      if (level !== 'off') {
        issues.push({
          path: `reasoningEfforts.${level}`,
          message: `等级 ${level} 必须给出 dispatch 应发送的 wire 值；只有 off 可以留空`,
        })
      }
      continue
    }
    if (typeof wire !== 'string') {
      issues.push({ path: `reasoningEfforts.${level}`, message: `等级 ${level} 的 wire 值必须是字符串` })
      continue
    }
    if (wire.length === 0) {
      issues.push({ path: `reasoningEfforts.${level}`, message: `等级 ${level} 的 wire 值不能是空字符串` })
    }
  }
  if (!THINKING_LEVELS_WITHOUT_OFF.some((level) => Object.hasOwn(value, level))) {
    issues.push({
      path: 'reasoningEfforts',
      message: 'reasoningEfforts 只提供了 off；请声明至少一个思考等级，或改 false 表示非推理模型',
    })
  }
  return issues
}

function validatePositiveInteger(value: unknown, path: string): FieldIssue[] {
  if (value === undefined || value === null) return []
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) {
    return [{ path, message: `${path} 必须是正整数` }]
  }
  return []
}

// 省略/空数组都表示「继承」，因此不报错。
function validateInput(value: unknown): FieldIssue[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return [{ path: 'input', message: 'input 必须是模态数组（text / image）' }]
  const issues: FieldIssue[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !isModality(item)) {
      issues.push({ path: 'input', message: `未知模态「${String(item)}」；可用值为 text、image` })
    }
  }
  if (new Set(value).size !== value.length) issues.push({ path: 'input', message: 'input 不能包含重复模态' })
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
  if (!entry.id || typeof entry.id !== 'string') issues.push({ path: 'id', message: '模型 id 不能为空' })
  if (entry.name !== undefined && (typeof entry.name !== 'string' || entry.name.length === 0)) {
    issues.push({ path: 'name', message: '显示名不能为空；留空即回退目录名再回退 id' })
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
