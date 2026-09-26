import type { SchemaNode } from '@deepseek-ai/dsh-client-ui-settings/client'
import { THINKING_LEVELS, type PiAiModality, type ThinkingLevel } from './types'

export interface PiAiChoices {
  protocols: readonly string[]
  thinkingLevels: readonly ThinkingLevel[]
  thinkingFormats: readonly string[]
  modalities: readonly PiAiModality[]
}

/** 官方 schema 无法内省时的保守回退（与 0.1.5-rc.2 的取值一致）。 */
export const FALLBACK_CHOICES: PiAiChoices = {
  protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
  thinkingLevels: THINKING_LEVELS,
  thinkingFormats: [
    'openai',
    'deepseek',
    'openrouter',
    'together',
    'baseten',
    'zai',
    'qwen',
    'chat-template',
    'qwen-chat-template',
    'string-thinking',
    'ant-ling',
  ],
  modalities: ['text', 'image'],
}

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null
}

function nodeAt(root: unknown, path: readonly string[]): SchemaNode | undefined {
  let node: unknown = root
  for (const key of path) {
    if (!isNode(node)) return undefined
    if (node.type === 'object') node = node.dict?.[key]
    else if (node.type === 'dict' || node.type === 'array') node = node.inner
    else return undefined
  }
  return isNode(node) ? node : undefined
}

function unionStrings(node: SchemaNode | undefined): string[] {
  const target = node?.type === 'array' ? node.inner : node
  if (target?.type !== 'union' || !Array.isArray(target.list)) return []
  return target.list.flatMap((entry) =>
    entry?.type === 'const' && typeof entry.value === 'string' ? [entry.value] : [],
  )
}

// providers 是 dict，路径上的具体 route 名无关紧要，直接进 inner。
function profileNode(root: unknown): SchemaNode | undefined {
  const providers = nodeAt(root, ['providers'])
  if (providers?.type !== 'dict') return undefined
  return isNode(providers.inner) ? providers.inner : undefined
}

// 从 settings namespace 序列化的 schema envelope 里读选项，与 Host 校验用
// 同一份 schema（做法同官方 Models 页的 protocolChoices()）。
export function readChoices(serializedSchema: unknown): PiAiChoices {
  const profile = profileNode(serializedSchema)
  if (profile === undefined) return FALLBACK_CHOICES
  const protocols = unionStrings(nodeAt(profile, ['api']))
  const thinkingLevels = unionStrings(nodeAt(profile, ['reasoning'])).filter(
    (level): level is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(level),
  )
  const thinkingFormats = unionStrings(nodeAt(profile, ['compat', 'thinkingFormat']))
  const modalities = unionStrings(nodeAt(profile, ['defaultInput'])).filter(
    (value): value is PiAiModality => value === 'text' || value === 'image',
  )
  return {
    protocols: protocols.length > 0 ? protocols : FALLBACK_CHOICES.protocols,
    thinkingLevels: thinkingLevels.length > 0 ? thinkingLevels : FALLBACK_CHOICES.thinkingLevels,
    thinkingFormats: thinkingFormats.length > 0 ? thinkingFormats : FALLBACK_CHOICES.thinkingFormats,
    modalities: modalities.length > 0 ? modalities : FALLBACK_CHOICES.modalities,
  }
}
