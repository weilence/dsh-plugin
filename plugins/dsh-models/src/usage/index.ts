import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { errMsg } from '@dsh-plugins/shared'
import { COPILOT_CREDENTIAL_KEY, readCopilotQuota } from './copilot'
import { CODEX_CREDENTIAL_KEY, readCodexQuota } from './codex'
import { createUsageService as createZhipuUsageService } from './zhipu'
import { USAGE_PROVIDERS, type ProviderUsage } from './types'

export type { ProviderUsage } from './types'

export type UsageProvider = keyof typeof USAGE_PROVIDERS

export function isUsageProvider(value: string): value is UsageProvider {
  return Object.hasOwn(USAGE_PROVIDERS, value)
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
    if (!value.ok) throw new Error(value.error)
    return {
      kind: 'quota',
      provider: 'zai-coding-cn',
      label: '智谱',
      windows: value.windows,
      queriedAt: value.queriedAt,
    }
  }

  async function readCodex(): Promise<ProviderUsage> {
    const value = await readCodexQuota(ctx)
    return {
      kind: 'quota',
      provider: 'openai-codex',
      label: 'Codex',
      windows: value.windows.map((window) => {
        const bucketId = window.bucketId ?? 'codex'
        const duration =
          window.windowMins === 300
            ? '5 小时'
            : window.windowMins === 10080
              ? '每周'
              : window.windowMins
                ? `${window.windowMins} 分钟`
                : window.kind === 'primary'
                  ? '主窗口'
                  : '次窗口'
        const bucketName = bucketId === 'codex' ? null : (window.bucketName ?? bucketId)
        return {
          id: `${bucketId}:${window.kind}`,
          label: bucketName ? `${bucketName} · ${duration}` : duration,
          usedPct: window.usedPct,
          resetMs: window.resetMs,
        }
      }),
      queriedAt: Date.now(),
    }
  }

  async function readCopilot(): Promise<ProviderUsage> {
    const quota = await readCopilotQuota(ctx)
    return {
      kind: 'quota',
      provider: 'github-copilot',
      label: 'Copilot',
      windows: [
        {
          id: 'premium_interactions',
          label: '高级请求',
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
        return { kind: 'unavailable', provider, label: USAGE_PROVIDERS[provider], error: errMsg(error) }
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
        return { kind: 'unavailable', provider, label: USAGE_PROVIDERS[provider], error: errMsg(error) }
      }
    })()
    const shared = (async (): Promise<ProviderUsage> => {
      const value = await task
      if (generation !== generations[accountProvider]) {
        return {
          kind: 'unavailable',
          provider,
          label: USAGE_PROVIDERS[provider],
          error: `${USAGE_PROVIDERS[provider]} 授权已更新，请重新查询。`,
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
