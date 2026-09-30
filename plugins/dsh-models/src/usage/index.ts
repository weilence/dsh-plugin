import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { errMsg } from '@dsh-plugins/shared'
import { getCopilotBilledUsage } from './copilot'
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
  let codexGeneration = 0
  ctx.on('credentials/record-updated', (key) => {
    if (key !== CODEX_CREDENTIAL_KEY) return
    codexGeneration += 1
    cached.delete('openai-codex')
    running.delete('openai-codex')
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
    const username = process.env['DSH_COPILOT_BILLING_USERNAME']
    const org = process.env['DSH_COPILOT_BILLING_ORG']
    const token = await credential('COPILOT_BILLING_TOKEN')
    if (!token) throw new Error('未配置 COPILOT_BILLING_TOKEN（需 GitHub Billing REST 读取权限）')
    const data = await getCopilotBilledUsage({
      token,
      ...(username ? { username } : {}),
      ...(org ? { org } : {}),
    })
    const period = [
      data.timePeriod.year,
      data.timePeriod.month?.toString().padStart(2, '0'),
      data.timePeriod.day?.toString().padStart(2, '0'),
    ]
      .filter(Boolean)
      .join('-')
    const items = data.usageItems.map((item) => ({
      label: item.model ?? item.sku,
      requests: item.grossQuantity,
    }))
    return {
      kind: 'billing',
      provider: 'github-copilot',
      label: 'Copilot',
      payer: `${data.payer.kind === 'user' ? '个人' : '组织'} ${data.payer.name}`,
      payerKind: data.payer.kind,
      period,
      items,
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
    const generation = codexGeneration
    const task = (async (): Promise<ProviderUsage> => {
      try {
        return provider === 'openai-codex' ? await readCodex() : await readCopilot()
      } catch (error) {
        return { kind: 'unavailable', provider, label: USAGE_PROVIDERS[provider], error: errMsg(error) }
      }
    })()
    const shared = (async (): Promise<ProviderUsage> => {
      const value = await task
      if (provider === 'openai-codex' && generation !== codexGeneration) {
        return {
          kind: 'unavailable',
          provider,
          label: USAGE_PROVIDERS[provider],
          error: 'Codex 授权已更新，请重新查询。',
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
