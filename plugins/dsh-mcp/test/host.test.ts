/** host 路由：守卫函数 + 假 ctx/webServer/loader 上的六路由集成往返（临时目录落盘）。 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply } from '../src/index'
import { isExpectedHost, isTrustedFetch } from '@dsh-plugins/shared/http'
import { ENTRY_PREFIX } from '../src/shared'
import { stdioConfig, STUB_INITIALIZER } from './stub'

function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('isExpectedHost', () => {
  it('精确匹配放行', () => {
    expect(isExpectedHost(req({ host: '127.0.0.1:8080' }), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(req({ host: 'localhost:8080' }), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(req({ host: '[::1]:8080' }), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(req({ host: '127.8.8.8:8080' }), 'localhost')).toBe(true)
  })

  it('非 loopback 的 Host 头拒绝', () => {
    expect(isExpectedHost(req({ host: 'evil.example:8080' }), '127.0.0.1')).toBe(false)
    expect(isExpectedHost(req({ host: '127.0.0.1.evil.example' }), '127.0.0.1')).toBe(false)
  })

  it('畸形 Host 头拒绝', () => {
    expect(isExpectedHost(req({}), '127.0.0.1')).toBe(false)
    expect(isExpectedHost(req({ host: 'a/b@example.com' }), '127.0.0.1')).toBe(false)
    expect(isExpectedHost(req({ host: 'not a host' }), '127.0.0.1')).toBe(false)
  })
})

describe('isTrustedFetch', () => {
  it('同源与头缺失（dsh-app: 协议）放行', () => {
    expect(isTrustedFetch(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(isTrustedFetch(req({}))).toBe(true)
    expect(isTrustedFetch(req({ 'sec-fetch-site': 'none' }))).toBe(true)
  })

  it('跨站标记拒绝', () => {
    expect(isTrustedFetch(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isTrustedFetch(req({ 'sec-fetch-site': 'same-site' }))).toBe(false)
  })
})

interface CapturedResponse {
  status: number
  body: Record<string, unknown>
}

/** 假 Loader：记录 create / update / remove 调用，维护一份内存条目表。 */
interface FakeEntry {
  options: { id: string; name: string; config?: Record<string, unknown>; disabled?: boolean }
  disabled?: boolean
  fiber?: { state: number; await: () => Promise<void> }
  parent?: unknown
}

interface Harness {
  root: string
  homeDir: string
  workspaceDir: string
  globalFile: string
  workspaceFile: string
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<CapturedResponse>
  setLive(live: unknown): void
  mountEntry(entry: FakeEntry): void
  loaderLog(): { op: string; id: string; options?: Record<string, unknown> }[]
  loaderEntryIds(): string[]
}

function postReq(body: unknown, headers: Record<string, string | string[] | undefined>): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body))
  const stream = (async function* () {
    yield payload
  })()
  return {
    headers,
    method: 'POST',
    url: '/',
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  const captured: CapturedResponse = { status: 0, body: {} }
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status
      void headers
    },
    end(payload?: Buffer) {
      try {
        captured.body = JSON.parse((payload ?? Buffer.alloc(0)).toString('utf8')) as Record<string, unknown>
      } catch {
        captured.body = {}
      }
    },
  } as unknown as ServerResponse
  return { res, done: Promise.resolve(captured) }
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-test-'))
  const homeDir = join(root, 'home')
  const workspaceDir = join(root, 'workspace')
  await mkdir(homeDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  const registrations = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  let live: unknown = { entries: () => [][Symbol.iterator](), schemas: () => [] }
  // 与真 Loader 的 Dict 形态一致：store 是普通对象（syncEntries 的占用检查
  // 走 store[id] 下标访问）。
  const loaderEntries: Record<string, FakeEntry> = Object.create(null)
  const log: { op: string; id: string; options?: Record<string, unknown> }[] = []
  const loader = {
    store: loaderEntries,
    entries: () => Object.values(loaderEntries)[Symbol.iterator](),
    create: async (options: { id?: string; name: string; config?: unknown; disabled?: boolean }) => {
      const id = options.id ?? Math.random().toString(16).slice(2)
      loaderEntries[id] = { options: { ...options, id } as FakeEntry['options'] }
      log.push({ op: 'create', id, options: options as Record<string, unknown> })
      return id
    },
    update: async (id: string, options: Record<string, unknown>) => {
      const entry = loaderEntries[id]
      if (entry === undefined) throw new Error(`cannot resolve entry ${id}`)
      Object.assign(entry.options, options)
      log.push({ op: 'update', id, options })
      return id
    },
    remove: (id: string) => {
      delete loaderEntries[id]
      log.push({ op: 'remove', id })
    },
  }
  const ctx = {
    effect: (register: () => unknown) => register(),
    webServer: {
      host: '127.0.0.1',
      register(options: {
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
      }) {
        registrations.set(options.path, options.handler)
        return () => registrations.delete(options.path)
      },
    },
    get: (name: string): unknown => {
      if (name === 'profileContext') {
        return { name: 'desktop', patchPath: join(homeDir, 'cordis.patch.yml'), home: homeDir }
      }
      if (name === 'loader') return loader
      if (name === 'tools') return live
      return undefined
    },
  }
  apply(ctx as never)
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) => {
    const handler = registrations.get(new URL(path, 'http://localhost').pathname)
    if (handler === undefined) throw new Error(`no handler for ${path}`)
    const headers = { host: '127.0.0.1:19387', ...extraHeaders }
    const { res, done } = fakeRes()
    const req =
      method === 'GET'
        ? ({ headers, method, url: path } as unknown as IncomingMessage)
        : postReq(body, headers)
    await handler(req, res)
    return done
  }
  return {
    root,
    homeDir,
    workspaceDir,
    globalFile: join(homeDir, 'mcp.json'),
    workspaceFile: join(workspaceDir, '.mcp.json'),
    request,
    setLive: (value: unknown) => (live = value),
    mountEntry: (entry: FakeEntry) => {
      loaderEntries[entry.options.id] = entry
    },
    loaderLog: () => log,
    loaderEntryIds: () => Object.keys(loaderEntries),
  }
}

const GLOBAL_STDIO = {
  mcpServers: {
    demo: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      reconnect: { enabled: false },
    },
  },
}

let harness: Harness

beforeEach(async () => {
  harness = await makeHarness()
})

afterEach(async () => {
  await rm(harness.root, { recursive: true, force: true })
})

describe('list 路由', () => {
  it('组合全局与工作区两档，运行态按条目 id 匹配，工具按前缀计数', async () => {
    await writeFile(harness.globalFile, JSON.stringify(GLOBAL_STDIO))
    // 运行态来自 Loader 条目（collectLiveMcp 遍历 loader.entries()），工具
    // 数来自工具注册表；这里分别用 mountEntry 与 setLive 摆出两路事实。
    harness.mountEntry({
      options: {
        id: `${ENTRY_PREFIX}global-demo`,
        name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: 'demo' },
      },
      disabled: false,
      fiber: { state: 2, await: async () => {} },
      parent: {},
    })
    harness.setLive({
      schemas: () => [{ name: 'mcp__demo__ping' }, { name: 'mcp__demo__pong' }, { name: 'mcp__other__x' }],
    })
    const response = await harness.request('GET', '/dsh-mcp/list')
    expect(response.status).toBe(200)
    const servers = response.body.servers as Record<string, unknown>[]
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({ scope: 'global', name: 'demo', disabled: false })
    expect(servers[0]?.config).toMatchObject({
      transport: 'stdio',
      serverName: 'demo',
      command: 'npx',
      args: ['-y', 'pkg'],
      // 未知键身份保留。
      reconnect: { enabled: false },
    })
    expect(servers[0]?.live).toMatchObject({
      status: 'active',
      tools: ['mcp__demo__ping', 'mcp__demo__pong'],
    })
    expect(response.body.profileName).toBe('desktop')
    expect(response.body.globalPath).toBe(harness.globalFile)
    expect((response.body.revisions as Record<string, unknown>).global).toBeTypeOf('string')
  })

  it('工作区档条目与全局同名遮蔽：全局标记 shadowed 且不挂载', async () => {
    await writeFile(harness.globalFile, JSON.stringify(GLOBAL_STDIO))
    await writeFile(
      harness.workspaceFile,
      JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['server.js'] } } }),
    )
    const response = await harness.request(
      'GET',
      `/dsh-mcp/list?cwd=${encodeURIComponent(harness.workspaceDir)}`,
    )
    const servers = response.body.servers as Record<string, unknown>[]
    const globalRow = servers.find((row) => row.scope === 'global')
    const workspaceRow = servers.find((row) => row.scope === 'workspace')
    expect(globalRow).toMatchObject({ name: 'demo', shadowed: true, live: null })
    expect(workspaceRow).toMatchObject({ name: 'demo', disabled: false })
    expect(workspaceRow?.config).toMatchObject({ transport: 'stdio', serverName: 'demo', command: 'node' })
    expect(response.body.workspacePath).toBe(harness.workspaceFile)
  })

  it('不合法条目照常产出并带原因，其余条目不受影响', async () => {
    await writeFile(
      harness.globalFile,
      JSON.stringify({
        mcpServers: {
          'bad name': { command: 'npx' },
          broken: 'not-an-object',
          good: { command: 'npx' },
        },
      }),
    )
    const response = await harness.request('GET', '/dsh-mcp/list')
    const servers = response.body.servers as Record<string, unknown>[]
    expect(servers).toHaveLength(3)
    expect(servers.find((row) => row.name === 'bad name')?.invalid).toBeTypeOf('string')
    expect(servers.find((row) => row.name === 'broken')?.invalid).toBeTypeOf('string')
    expect(servers.find((row) => row.name === 'good')?.invalid).toBeUndefined()
  })

  it('文件解析失败降级为空档 + 告警，另一档不受影响', async () => {
    await writeFile(harness.globalFile, '{ not json')
    await writeFile(harness.workspaceFile, JSON.stringify({ mcpServers: { demo: { command: 'npx' } } }))
    const response = await harness.request(
      'GET',
      `/dsh-mcp/list?cwd=${encodeURIComponent(harness.workspaceDir)}`,
    )
    expect(response.status).toBe(200)
    const warnings = response.body.warnings as string[]
    expect(warnings.some((warning) => warning.includes('mcp.json 解析失败'))).toBe(true)
    expect((response.body.servers as Record<string, unknown>[]).map((row) => row.scope)).toEqual([
      'workspace',
    ])
  })

  it('缺 cwd 时工作区档为 null；cwd 上报后记忆并在切换时卸载旧项目条目', async () => {
    await writeFile(harness.workspaceFile, JSON.stringify({ mcpServers: { demo: { command: 'npx' } } }))
    const bare = await harness.request('GET', '/dsh-mcp/list')
    expect(bare.body.workspacePath).toBeNull()

    const reported = await harness.request('POST', '/dsh-mcp/cwd', { cwd: harness.workspaceDir })
    expect(reported.status).toBe(200)
    const listed = await harness.request('GET', '/dsh-mcp/list')
    expect(listed.body.workspacePath).toBe(harness.workspaceFile)
    expect(harness.loaderEntryIds()).toEqual([`${ENTRY_PREFIX}workspace-demo`])

    const other = join(harness.root, 'other')
    await mkdir(other, { recursive: true })
    await harness.request('POST', '/dsh-mcp/cwd', { cwd: other })
    expect(harness.loaderEntryIds()).toEqual([])
  })
})

describe('save 路由', () => {
  it('新建写入目标文件（stdio 不落 type，serverName 由键承载）并动态挂载', async () => {
    const response = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'global',
      name: 'demo',
      config: { transport: 'stdio', serverName: 'demo', command: 'npx', args: ['-y', 'pkg'] },
      extra: { reconnect: { enabled: false } },
      revision: null,
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ scope: 'global', name: 'demo' })
    const saved = JSON.parse(await readFile(harness.globalFile, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(saved.mcpServers.demo).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
      reconnect: { enabled: false },
    })
    const create = harness.loaderLog().find((row) => row.op === 'create')
    expect(create).toMatchObject({ id: `${ENTRY_PREFIX}global-demo` })
    expect(create?.options).toMatchObject({ name: '@deepseek-ai/dsh-mcp-client' })
  })

  it('同名覆盖即编辑，disabled 落文件扩展键并更新挂载', async () => {
    await harness.request('POST', '/dsh-mcp/save', {
      scope: 'global',
      name: 'demo',
      config: { transport: 'stdio', serverName: 'demo', command: 'npx' },
      revision: null,
    })
    const listed = await harness.request('GET', '/dsh-mcp/list')
    const revision = (listed.body.revisions as Record<string, unknown>).global as string
    const disabled = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'global',
      name: 'demo',
      config: { transport: 'stdio', serverName: 'demo', command: 'npx' },
      disabled: true,
      revision,
    })
    expect(disabled.status).toBe(200)
    const saved = JSON.parse(await readFile(harness.globalFile, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(saved.mcpServers.demo).toMatchObject({ command: 'npx', disabled: true })
    expect(
      harness.loaderLog().some((row) => row.op === 'update' && row.id === `${ENTRY_PREFIX}global-demo`),
    ).toBe(true)
  })

  it('revision 不匹配 409；跨档同名是遮蔽语义不拒绝', async () => {
    await writeFile(harness.globalFile, JSON.stringify(GLOBAL_STDIO))
    const stale = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'global',
      name: 'demo',
      config: { transport: 'stdio', serverName: 'demo', command: 'npx' },
      revision: null,
    })
    expect(stale.status).toBe(409)
    const cross = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'workspace',
      name: 'demo',
      config: { transport: 'stdio', serverName: 'demo', command: 'node' },
      revision: null,
      cwd: harness.workspaceDir,
    })
    expect(cross.status).toBe(200)
  })

  it('坏配置 400、新名即创建 200、工作区档缺 cwd 409', async () => {
    expect(
      (
        await harness.request('POST', '/dsh-mcp/save', {
          scope: 'global',
          name: 'x y',
          config: { transport: 'stdio', serverName: 'x y', command: 'n' },
          revision: null,
        })
      ).status,
    ).toBe(400)
    // 同名即编辑、新名即创建：目标文件里没有该键不算 404。
    expect(
      (
        await harness.request('POST', '/dsh-mcp/save', {
          scope: 'global',
          name: 'none',
          config: { transport: 'stdio', serverName: 'none', command: 'n' },
          revision: null,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await harness.request('POST', '/dsh-mcp/save', {
          scope: 'workspace',
          name: 'demo',
          config: { transport: 'stdio', serverName: 'demo', command: 'n' },
          revision: null,
        })
      ).status,
    ).toBe(409)
  })
})

describe('check 路由', () => {
  it('坏配置 400', async () => {
    const response = await harness.request('POST', '/dsh-mcp/check', {
      config: { transport: 'stdio', serverName: 'x y', command: 'n' },
    })
    expect(response.status).toBe(400)
  })

  it('stdio 握手成功 ok:true', async () => {
    const response = await harness.request('POST', '/dsh-mcp/check', {
      config: stdioConfig(STUB_INITIALIZER),
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })

  it('握手失败 ok:false 带原因', async () => {
    const response = await harness.request('POST', '/dsh-mcp/check', {
      config: stdioConfig('process.exit(1)'),
    })
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(false)
    expect(response.body.error).toContain('提前退出')
  })

  it('跨站 POST 403', async () => {
    const response = await harness.request(
      'POST',
      '/dsh-mcp/check',
      { config: { transport: 'stdio', serverName: 'x', command: 'n' } },
      { 'sec-fetch-site': 'cross-site' },
    )
    expect(response.status).toBe(403)
  })
})

describe('set-enabled 路由', () => {
  it('启停翻转文件里的 disabled 扩展键并同步挂载', async () => {
    await harness.request('POST', '/dsh-mcp/save', {
      scope: 'global',
      name: 'demo',
      config: { transport: 'stdio', serverName: 'demo', command: 'npx' },
      revision: null,
    })
    const listed = await harness.request('GET', '/dsh-mcp/list')
    const revision = (listed.body.revisions as Record<string, unknown>).global as string
    const off = await harness.request('POST', '/dsh-mcp/set-enabled', {
      scope: 'global',
      name: 'demo',
      enabled: false,
      revision,
    })
    expect(off.status).toBe(200)
    const saved = JSON.parse(await readFile(harness.globalFile, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(saved.mcpServers.demo).toMatchObject({ disabled: true })
    const listedAgain = await harness.request('GET', '/dsh-mcp/list')
    const revision2 = (listedAgain.body.revisions as Record<string, unknown>).global as string
    await harness.request('POST', '/dsh-mcp/set-enabled', {
      scope: 'global',
      name: 'demo',
      enabled: true,
      revision: revision2,
    })
    const savedAgain = JSON.parse(await readFile(harness.globalFile, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(savedAgain.mcpServers.demo).not.toHaveProperty('disabled')
  })

  it('未知条目 404、revision 过期 409', async () => {
    expect(
      (
        await harness.request('POST', '/dsh-mcp/set-enabled', {
          scope: 'global',
          name: 'none',
          enabled: false,
          revision: null,
        })
      ).status,
    ).toBe(404)
    await writeFile(harness.globalFile, JSON.stringify(GLOBAL_STDIO))
    expect(
      (
        await harness.request('POST', '/dsh-mcp/set-enabled', {
          scope: 'global',
          name: 'demo',
          enabled: false,
          revision: null,
        })
      ).status,
    ).toBe(409)
  })
})

describe('delete 路由', () => {
  it('删除后文件无该键，挂载条目卸载', async () => {
    await harness.request('POST', '/dsh-mcp/save', {
      scope: 'global',
      name: 'demo',
      config: { transport: 'stdio', serverName: 'demo', command: 'npx' },
      revision: null,
    })
    const listed = await harness.request('GET', '/dsh-mcp/list')
    const revision = (listed.body.revisions as Record<string, unknown>).global as string
    const response = await harness.request('POST', '/dsh-mcp/delete', {
      scope: 'global',
      name: 'demo',
      revision,
    })
    expect(response.status).toBe(200)
    const saved = JSON.parse(await readFile(harness.globalFile, 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(saved.mcpServers.demo).toBeUndefined()
    expect(
      harness.loaderLog().some((row) => row.op === 'remove' && row.id === `${ENTRY_PREFIX}global-demo`),
    ).toBe(true)
  })

  it('不合法条目也能删除', async () => {
    await writeFile(harness.globalFile, JSON.stringify({ mcpServers: { broken: 'x' } }))
    const listed = await harness.request('GET', '/dsh-mcp/list')
    const revision = (listed.body.revisions as Record<string, unknown>).global as string
    const response = await harness.request('POST', '/dsh-mcp/delete', {
      scope: 'global',
      name: 'broken',
      revision,
    })
    expect(response.status).toBe(200)
  })
})

describe('安全守卫', () => {
  it('非 loopback Host 与跨站 POST 一律 403', async () => {
    const badHost = await harness.request('GET', '/dsh-mcp/list', undefined, { host: 'evil.example:1' })
    expect(badHost.status).toBe(403)
    const crossSite = await harness.request(
      'POST',
      '/dsh-mcp/save',
      { scope: 'global', name: 'x' },
      { 'sec-fetch-site': 'cross-site' },
    )
    expect(crossSite.status).toBe(403)
  })
})
