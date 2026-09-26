import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOperations, PI_AI_NS, type OperationsContext } from '../src/client/operations'

function withDiscoverModels(discoverModels: unknown) {
  return createOperations({ remote: { llm: { discoverModels } } } as unknown as OperationsContext)
}

afterEach(() => vi.useRealTimers())

describe('获取 Endpoint 模型', () => {
  it('成功返回模型并传递取消信号', async () => {
    vi.useFakeTimers()
    const models = [{ id: 'model-1' }]
    const discoverModels = vi.fn(async (_ns: unknown, _request: unknown, _signal: AbortSignal) => ({
      ok: true,
      value: models,
    }))
    const operations = withDiscoverModels(discoverModels)
    const request = { baseURL: 'https://example.com', api: 'openai-completions' }
    expect(await operations.discoverEndpoint(request)).toEqual(models)
    expect(discoverModels).toHaveBeenCalledWith(PI_AI_NS, request, expect.any(AbortSignal))
    expect(discoverModels.mock.calls[0]?.[2].aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('超过 5 秒时取消 Host 请求并报超时，不等待迟到的应答', async () => {
    vi.useFakeTimers()
    const discoverModels = vi.fn((_ns: unknown, _request: unknown, _signal: unknown) => new Promise(() => {}))
    const operations = withDiscoverModels(discoverModels)
    const pending = operations.discoverEndpoint({ baseURL: 'https://example.com' })
    const rejected = expect(pending).rejects.toThrow('获取模型列表超时（5 秒）')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(discoverModels.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal)
    expect((discoverModels.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect((discoverModels.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('Host 失败时保留原错误并清理计时器', async () => {
    vi.useFakeTimers()
    const operations = withDiscoverModels(async () => ({ ok: false, error: { message: '密钥无效' } }))
    await expect(operations.discoverEndpoint({ baseURL: 'https://example.com' })).rejects.toThrow('密钥无效')
    expect(vi.getTimerCount()).toBe(0)
  })
})
