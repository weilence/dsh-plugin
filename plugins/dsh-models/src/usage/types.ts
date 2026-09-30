export const USAGE_PROVIDERS = {
  'zai-coding-cn': '智谱',
  'openai-codex': 'Codex',
  'github-copilot': 'Copilot',
} as const

export interface UsageWindow {
  id: string
  label: string
  usedPct: number | null
  resetMs: number | null
}

export type ProviderUsage =
  | {
      kind: 'quota'
      provider: 'zai-coding-cn' | 'openai-codex'
      label: string
      windows: UsageWindow[]
      queriedAt: number
    }
  | {
      kind: 'billing'
      provider: 'github-copilot'
      label: string
      payer: string
      payerKind: 'user' | 'organization'
      period: string
      items: { label: string; requests: number }[]
      queriedAt: number
    }
  | { kind: 'unavailable'; provider: string; label: string; error: string }
