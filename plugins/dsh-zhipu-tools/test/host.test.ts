/** 宿主装配：假 ctx（credentials / web / 事件总线）下 provider 注册、启动日志与凭据快照刷新。 */

import { describe, expect, it } from 'vitest'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { apply } from '../src/index'

type Listener = (ref: CredentialRef) => void

/** 宿主 user-settings 里 locale 行的可配置形状（不传 = 组合里没有这一行；`{}` = 有行未显式选语言）。 */
interface LocaleRow {
  preference?: string
}

interface Harness {
  searchProviders: { id: string; title?: string; description?: unknown; available(): boolean }[]
  fetchProviders: { id: string; title?: string; description?: unknown; available(): boolean }[]
  errors: string[]
  /** 测试里手动派发宿主事件：触发 apply 里注册的监听，并等重查微任务链走完。 */
  emitReferenceUpdated: (ref: string) => Promise<void>
  resolveCalls: string[]
  dispose: () => Promise<void>
}

function makeHarness(
  resolve: (name: string) => Promise<unknown>,
  options: { locale?: LocaleRow } = {},
): Promise<Harness> {
  const disposers: Array<() => unknown> = []
  const errors: string[] = []
  const resolveCalls: string[] = []
  const searchProviders: Harness['searchProviders'] = []
  const fetchProviders: Harness['fetchProviders'] = []
  const referenceListeners = new Set<Listener>()

  const ctx = {
    credentials: {
      resolve: async (name: string) => {
        resolveCalls.push(name)
        return resolve(name)
      },
    },
    effect: (register: () => unknown) => {
      const dispose = register() as () => unknown
      disposers.push(dispose)
      return dispose
    },
    // 宿主事件总线：记录监听供测试派发，dispose 随 effect 注销。
    on: (_event: string, listener: Listener) => {
      referenceListeners.add(listener)
      return () => referenceListeners.delete(listener)
    },
    // 只提供本插件关心的 locale 行（override 即用户显式选择，inherited 即下层组合值）。
    configEditor: {
      configuration: () =>
        options.locale === undefined
          ? []
          : [
              {
                entry: { options: { id: 'locale' } },
                override: { ...options.locale },
                inherited: {},
              },
            ],
    },
    web: {
      registerSearchProvider(provider: Harness['searchProviders'][number]) {
        searchProviders.push(provider)
        return () => {
          const index = searchProviders.indexOf(provider)
          if (index >= 0) searchProviders.splice(index, 1)
        }
      },
      registerFetchProvider(provider: Harness['fetchProviders'][number]) {
        fetchProviders.push(provider)
        return () => {
          const index = fetchProviders.indexOf(provider)
          if (index >= 0) fetchProviders.splice(index, 1)
        }
      },
    },
    logger: {
      error: (message: string) => errors.push(message),
      info: () => {},
    },
  }
  const applyPromise = apply(ctx as never)

  return applyPromise.then(() => ({
    searchProviders,
    fetchProviders,
    errors,
    resolveCalls,
    emitReferenceUpdated: async (ref: string) => {
      for (const listener of referenceListeners) listener(ref as CredentialRef)
      // 重查是监听里 void 出去的 promise 链：等一个宏任务保证全部微任务结算。
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 0))
    },
    dispose: async () => {
      for (const dispose of disposers) await dispose()
    },
  }))
}

const resolveWithKey = async (name: string): Promise<unknown> =>
  name === 'ZAI_CODING_CN_API_KEY' ? { value: 'k', source: 'env' } : undefined

describe('provider 注册', () => {
  it('apply 后两个 provider 在册（含下拉显示名与选中说明），dispose 后全部注销', async () => {
    const harness = await makeHarness(resolveWithKey)
    expect(harness.searchProviders.map((provider) => provider.id)).toEqual(['zhipu-search-api'])
    expect(harness.fetchProviders.map((provider) => provider.id)).toEqual(['zhipu-fetch-api'])
    // 官方设置页下拉按 title ?? id 显示、选中后按 description 展示说明行：两者必须声明。
    expect(harness.searchProviders[0]?.title).toBe('Zhipu Web Search')
    expect(harness.fetchProviders[0]?.title).toBe('Zhipu Web Reader')
    expect(harness.searchProviders[0]?.description).toHaveProperty('zh')
    expect(harness.searchProviders[0]?.description).toHaveProperty('en')
    expect(harness.fetchProviders[0]?.description).toHaveProperty('zh')
    expect(harness.fetchProviders[0]?.description).toHaveProperty('en')
    await harness.dispose()
    expect(harness.searchProviders).toHaveLength(0)
    expect(harness.fetchProviders).toHaveLength(0)
  })

  it('凭据缺席：启动即明确报错，provider 照常注册且快照不可用', async () => {
    const harness = await makeHarness(async () => undefined)
    expect(harness.errors[0]).toContain('未配置')
    expect(harness.searchProviders).toHaveLength(1)
    expect(harness.searchProviders[0]?.available()).toBe(false)
    expect(harness.fetchProviders[0]?.available()).toBe(false)
  })
})

describe('下拉显示名按 locale 偏好解析', () => {
  it.each([
    ['zh', '智谱联网搜索', '智谱网页阅读'],
    ['zh-TW', '智谱联网搜索', '智谱网页阅读'],
    ['en', 'Zhipu Web Search', 'Zhipu Web Reader'],
    ['ja', 'Zhipu Web Search', 'Zhipu Web Reader'],
  ] as const)('显式偏好 %s：两 provider 取对应语言', async (preference, searchTitle, fetchTitle) => {
    const harness = await makeHarness(resolveWithKey, { locale: { preference } })
    expect(harness.searchProviders[0]?.title).toBe(searchTitle)
    expect(harness.fetchProviders[0]?.title).toBe(fetchTitle)
  })

  it('偏好缺席（跟随浏览器）：组合无 locale 行或有行未显式选择，都用英文', async () => {
    const noRow = await makeHarness(resolveWithKey)
    expect(noRow.searchProviders[0]?.title).toBe('Zhipu Web Search')
    expect(noRow.fetchProviders[0]?.title).toBe('Zhipu Web Reader')

    const emptyRow = await makeHarness(resolveWithKey, { locale: {} })
    expect(emptyRow.searchProviders[0]?.title).toBe('Zhipu Web Search')
    expect(emptyRow.fetchProviders[0]?.title).toBe('Zhipu Web Reader')
  })
})

describe('凭据快照刷新', () => {
  it('点名本插件引用的更新重查凭据：快照翻转为可用；解析故障带原文进日志', async () => {
    let stored: unknown = undefined
    const harness = await makeHarness(async () => stored)
    expect(harness.searchProviders[0]?.available()).toBe(false)

    stored = { value: 'k', source: 'env' }
    await harness.emitReferenceUpdated('ZAI_CODING_CN_API_KEY')
    expect(harness.searchProviders[0]?.available()).toBe(true)
    expect(harness.fetchProviders[0]?.available()).toBe(true)

    // 解析故障：快照回落后故障原文透传日志（不在 provider 调用前静默吞掉）。
    stored = undefined
    const failing = await makeHarness(async (name) => {
      if (name === 'ZAI_CODING_CN_API_KEY') throw new Error('存储被锁')
      return undefined
    })
    await failing.emitReferenceUpdated('ZAI_CODING_CN_API_KEY')
    expect(failing.errors.some((message) => message.includes('存储被锁'))).toBe(true)
    expect(failing.searchProviders[0]?.available()).toBe(false)
  })

  it('无关引用的更新不触发重查', async () => {
    const harness = await makeHarness(resolveWithKey)
    const calls = harness.resolveCalls.length
    await harness.emitReferenceUpdated('DEEPSEEK_API_KEY')
    expect(harness.resolveCalls.length).toBe(calls)
  })
})
