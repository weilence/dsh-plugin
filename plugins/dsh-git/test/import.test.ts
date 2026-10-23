import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanRepos } from '../src/client/api'
import { GIT_HEADER, REPOS_PATH } from '../src/shared'

afterEach(() => vi.unstubAllGlobals())

describe('扫描请求封装', () => {
  it('POST 扫描路由，携带插件协议头、cwd 与中止信号', async () => {
    const done = { root: '/workspace', repos: [], truncated: false }
    const request = vi.fn(async (_path: string, _init: RequestInit) => Response.json(done))
    vi.stubGlobal('fetch', request)
    const signal = new AbortController().signal
    await expect(scanRepos('/workspace', signal)).resolves.toEqual(done)
    expect(request).toHaveBeenCalledWith(
      REPOS_PATH,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ cwd: '/workspace' }), signal }),
    )
    expect(request.mock.calls[0]![1].headers).toMatchObject({ [GIT_HEADER]: '1' })
  })

  it('HTTP 失败保留服务端原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: '目录不可访问：EACCES' }, { status: 400 })),
    )
    await expect(scanRepos('/workspace', new AbortController().signal)).rejects.toThrow(
      '目录不可访问：EACCES',
    )
  })
})
