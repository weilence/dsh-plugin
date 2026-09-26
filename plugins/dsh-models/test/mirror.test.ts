import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogMirror } from '../src/mirror'

const dirs: string[] = []
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-models-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function catalogBody() {
  return JSON.stringify({ demo: { id: 'demo', name: 'Demo', models: {} } })
}

describe('CatalogMirror', () => {
  it('首次 200 下载并持久化原始目录', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(catalogBody(), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"v1"' },
        }),
    )
    const dir = await tempDir()
    const mirror = new CatalogMirror({ cacheDir: dir, fetch: fetchMock, now: () => 100 })
    await expect(mirror.check()).resolves.toBe('updated')
    expect(mirror.snapshot()).toMatchObject({ etag: '"v1"', checkedAt: 100, updatedAt: 100, lastError: null })
    expect(await readFile(join(dir, 'api.json'), 'utf8')).toBe(catalogBody())
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))).toMatchObject({
      etag: '"v1"',
      checkedAt: 100,
      updatedAt: 100,
    })
  })

  it('后续请求携带 If-None-Match，304 不重新下载目录', async () => {
    let call = 0
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      call += 1
      if (call === 1)
        return new Response(catalogBody(), {
          status: 200,
          headers: { etag: '"v1"', 'content-type': 'application/json' },
        })
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"v1"')
      return new Response(null, {
        status: 304,
        headers: { etag: '"v1"', 'content-type': 'application/json' },
      })
    })
    let now = 100
    const mirror = new CatalogMirror({ cacheDir: await tempDir(), fetch: fetchMock, now: () => now })
    await mirror.check()
    now = 200
    await expect(mirror.check()).resolves.toBe('unchanged')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mirror.snapshot()).toMatchObject({ checkedAt: 200, updatedAt: 100 })
  })

  it('可从磁盘恢复最后成功快照', async () => {
    const dir = await tempDir()
    const first = new CatalogMirror({
      cacheDir: dir,
      fetch: vi.fn(
        async () =>
          new Response(catalogBody(), {
            status: 200,
            headers: { etag: '"v1"', 'content-type': 'application/json' },
          }),
      ),
      now: () => 123,
    })
    await first.check()
    const second = new CatalogMirror({ cacheDir: dir, fetch: vi.fn() as never })
    await expect(second.loadPersisted()).resolves.toBe(true)
    expect(second.snapshot()).toMatchObject({ etag: '"v1"', checkedAt: 123, updatedAt: 123 })
    expect(second.snapshot().body?.toString()).toBe(catalogBody())
  })

  it('并发检查共享同一个上游请求', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchMock = vi.fn(async () => {
      await wait
      return new Response(catalogBody(), {
        status: 200,
        headers: { etag: '"v1"', 'content-type': 'application/json' },
      })
    })
    const mirror = new CatalogMirror({ cacheDir: await tempDir(), fetch: fetchMock })
    const left = mirror.check()
    const right = mirror.check()
    release()
    await Promise.all([left, right])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('拒绝无效 JSON，不覆盖最后成功快照', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      return call === 1
        ? new Response(catalogBody(), {
            status: 200,
            headers: { etag: '"v1"', 'content-type': 'application/json' },
          })
        : new Response('<html>', {
            status: 200,
            headers: { etag: '"v2"', 'content-type': 'application/json' },
          })
    })
    const mirror = new CatalogMirror({ cacheDir: await tempDir(), fetch: fetchMock })
    await mirror.check()
    await expect(mirror.check()).rejects.toThrow()
    expect(mirror.snapshot().etag).toBe('"v1"')
  })
})
