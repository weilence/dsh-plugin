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
  remaining?: number | null
  entitlement?: number | null
  unlimited?: boolean
}

export type ProviderUsage =
  | {
      kind: 'quota'
      provider: 'zai-coding-cn' | 'openai-codex' | 'github-copilot'
      label: string
      windows: UsageWindow[]
      queriedAt: number
    }
  | { kind: 'unavailable'; provider: string; label: string; error: string }
