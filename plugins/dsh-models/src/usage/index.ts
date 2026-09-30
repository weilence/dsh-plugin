import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { errMsg } from '@dsh-plugins/shared'
import { COPILOT_CREDENTIAL_KEY, readCopilotQuota } from './copilot'
import { CODEX_CREDENTIAL_KEY, CodexQuotaError, readCodexQuota } from './codex'
import { createUsageService as createZhipuUsageService } from './zhipu'
import {
  USAGE_PROVIDERS,
  UsageError,
  type ProviderUsage,
  type UsageProviderId,
  type UsageWindowLabel,
} from './types'

export type { ProviderUsage } from './types'

export type UsageProvider = UsageProviderId

/** 异常 → 稳定原因码 + 安全详情：已知分类由抛出点携带，其余保真归 unknown。 */
function unavailable(provider: string, error: unknown): ProviderUsage {
  if (error instanceof UsageError)
    return { kind: 'unavailable', provider, code: error.code, detail: error.message }
  if (error instanceof CodexQuotaError && error.code === 'not_signed_in') {
    return { kind: 'unavailable', provider, code: 'not_signed_in', detail: error.message }
  }
  return { kind: 'unavailable', provider, code: 'unknown', detail: errMsg(error) }
}

export function isUsageProvider(value: string): value is UsageProvider {
  return (USAGE_PROVIDERS as readonly string[]).includes(value)
}

export function createProviderUsageService(ctx: Context) {
  let zhipuKey: string | null | undefined
  let zhipuService: ReturnType<typeof createZhipuUsageService> | undefined
  const cached = new Map<string, { value: ProviderUsage; at: number }>()
  const running = new Map<string, Promise<ProviderUsage>>()
  const generations = { 'openai-codex': 0, 'github-copilot': 0 }
  ctx.on('credentials/record-updated', (key) => {
    const provider =
      key === CODEX_CREDENTIAL_KEY ? 'openai-codex' : key === COPILOT_CREDENTIAL_KEY ? 'github-copilot' : null
    if (!provider) return
    generations[provider] += 1
    cached.delete(provider)
    running.delete(provider)
  })

  async function credential(name: string) {
    const store = ctx.get('credentials')
    if (store === undefined) throw new Error('未挂载 credentials 服务')
    return (await store.resolve(name as CredentialRef))?.value ?? null
  }

  async function readZhipu(force: boolean): Promise<ProviderUsage> {
    const errors: string[] = []
    let key: string | null = null
    for (const name of ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY']) {
      try {
        key = await credential(name)
        if (key) break
      } catch (error) {
        errors.push(`${name}: ${errMsg(error)}`)
      }
    }
    if (!key && errors.length) throw new Error(`智谱凭据解析失败：${errors.join('；')}`)
    if (zhipuService === undefined || key !== zhipuKey) {
      zhipuKey = key
      zhipuService = createZhipuUsageService(key)
    }
    const value = await zhipuService.fetchUsage(force)
    if (!value.ok) throw new UsageError(value.code, value.error)
    return {
      kind: 'quota',
      provider: 'zai-coding-cn',
      windows: value.windows,
      queriedAt: value.queriedAt,
    }
  }

  async function readCodex(): Promise<ProviderUsage> {
    const value = await readCodexQuota(ctx)
    return {
      kind: 'quota',
      provider: 'openai-codex',
      windows: value.windows.map((window) => {
        const bucketId = window.bucketId ?? 'codex'
        const bucketName = bucketId === 'codex' ? undefined : (window.bucketName ?? bucketId)
        const label: UsageWindowLabel = {
          kind: 'window',
          windowMins: window.windowMins ?? null,
          role: window.kind,
          ...(bucketName === undefined ? {} : { bucketName }),
        }
        return { id: `${bucketId}:${window.kind}`, label, usedPct: window.usedPct, resetMs: window.resetMs }
      }),
      queriedAt: Date.now(),
    }
  }

  async function readCopilot(): Promise<ProviderUsage> {
    const quota = await readCopilotQuota(ctx)
    return {
      kind: 'quota',
      provider: 'github-copilot',
      windows: [
        {
          id: 'premium_interactions',
          label: { kind: 'premiumRequests' },
          usedPct: quota.remainingPct === null ? null : 100 - quota.remainingPct,
          resetMs: quota.resetMs,
          remaining: quota.remaining,
          entitlement: quota.entitlement,
          unlimited: quota.unlimited,
        },
      ],
      queriedAt: Date.now(),
    }
  }

  async function read(provider: UsageProvider, force: boolean): Promise<ProviderUsage> {
    const pending = running.get(provider)
    if (pending) return pending
    if (provider === 'zai-coding-cn') {
      try {
        return await readZhipu(force)
      } catch (error) {
        return unavailable(provider, error)
      }
    }
    const hit = cached.get(provider)
    if (!force && hit && Date.now() - hit.at < (hit.value.kind === 'unavailable' ? 30_000 : 240_000))
      return hit.value
    const accountProvider = provider === 'openai-codex' ? provider : 'github-copilot'
    const generation = generations[accountProvider]
    const task = (async (): Promise<ProviderUsage> => {
      try {
        return provider === 'openai-codex' ? await readCodex() : await readCopilot()
      } catch (error) {
        return unavailable(provider, error)
      }
    })()
    const shared = (async (): Promise<ProviderUsage> => {
      const value = await task
      if (generation !== generations[accountProvider]) {
        return {
          kind: 'unavailable',
          provider,
          code: 'authorization_changed',
          // client 按稳定码翻译摘要；detail 记录可追查的事实，不带界面文案。
          detail: `credentials/record-updated during ${provider} query`,
        }
      }
      cached.set(provider, { value, at: Date.now() })
      return value
    })().finally(() => {
      if (running.get(provider) === shared) running.delete(provider)
    })
    running.set(provider, shared)
    return shared
  }

  return { read }
}
