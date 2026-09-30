import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUsageService, parseQuota, type QuotaWireBody } from '../src/usage/zhipu'

function okBody(): QuotaWireBody {
  return {
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 25, nextResetTime: 1730000000000 },
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 40, nextResetTime: 1730600000000 },
        { type: 'TIME_LIMIT', unit: 5, percentage: 7, usageDetails: [] },
      ],
    },
  }
}

function jsonResponse(body: QuotaWireBody): Response {
  return { text: async () => JSON.stringify(body) } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseQuota', () => {
  it('正常三窗口：标签、已用百分比、重置时间', () => {
    const windows = parseQuota(okBody())
    expect(windows.map((w) => w.label)).toEqual(['5 小时', '每周', '工具调用'])
    expect(windows.map((w) => w.usedPct)).toEqual([25, 40, 7])
    expect(windows[0].resetMs).toBe(1730000000000)
    expect(windows.map((w) => w.id)).toEqual(['TOKENS_LIMIT#3', 'TOKENS_LIMIT#6', 'TIME_LIMIT#5'])
  })

  it('未知 type 原样保留，label 回退为 type', () => {
    const windows = parseQuota({ data: { limits: [{ type: 'NEW_LIMIT', unit: 9 }] } })
    expect(windows).toHaveLength(1)
    expect(windows[0].label).toBe('NEW_LIMIT')
    expect(windows[0].usedPct).toBeNull()
    expect(windows[0].resetMs).toBeNull()
  })

  it('success:false 抛出接口 msg', () => {
    expect(() => parseQuota({ success: false, msg: '配额服务不可用' })).toThrow('配额服务不可用')
  })

  it('缺少 data 字段抛错', () => {
    expect(() => parseQuota({ success: true })).toThrow('响应缺少 data 字段')
  })

  it('limits 为空抛错', () => {
    expect(() => parseQuota({ data: { limits: [] } })).toThrow('响应缺少配额条目')
  })

  it('percentage 越界钳制到 [0,100]', () => {
    const windows = parseQuota({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, percentage: 150 },
          { type: 'TOKENS_LIMIT', unit: 6, percentage: -5 },
        ],
      },
    })
    expect(windows.map((w) => w.usedPct)).toEqual([100, 0])
  })

  it('unit 缺失时 id 以 ? 占位', () => {
    const windows = parseQuota({ data: { limits: [{ type: 'TIME_LIMIT' }] } })
    expect(windows[0].id).toBe('TIME_LIMIT#?')
  })
})

describe('createUsageService', () => {
  it('未配置凭证：ok:false，不发起请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const usage = createUsageService(null)
    const res = await usage.fetchUsage(false)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('zai-coding-cn')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('成功结果缓存：TTL 内二次调用不重新请求', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(okBody()))
    vi.stubGlobal('fetch', fetchMock)
    const usage = createUsageService('test-key')
    const first = await usage.fetchUsage(false)
    const second = await usage.fetchUsage(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('force 绕过缓存重新请求', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(okBody()))
    vi.stubGlobal('fetch', fetchMock)
    const usage = createUsageService('test-key')
    await usage.fetchUsage(false)
    await usage.fetchUsage(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('并发调用 inflight 去重为一次请求', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(okBody()))
    vi.stubGlobal('fetch', fetchMock)
    const usage = createUsageService('test-key')
    const [a, b] = await Promise.all([usage.fetchUsage(false), usage.fetchUsage(false)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('失败结果也缓存：TTL 内不重试', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('网络中断')))
    vi.stubGlobal('fetch', fetchMock)
    const usage = createUsageService('test-key')
    const first = await usage.fetchUsage(false)
    expect(first.ok).toBe(false)
    const second = await usage.fetchUsage(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('HTTP 成功但业务失败（success:false）透传 msg', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: false, msg: '限流' })),
    )
    const usage = createUsageService('test-key')
    const res = await usage.fetchUsage(false)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('限流')
  })
})
