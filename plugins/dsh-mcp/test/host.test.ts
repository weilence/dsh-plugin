/** host 路由：守卫函数 + 假 ctx/webServer 上的五路由集成往返（临时目录落盘）。 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Group } from '@deepseek-ai/cordis-plugin-loader'
import { apply } from '../src/index'
import { isExpectedHost, isTrustedFetch } from '@dsh-plugins/shared/http'
import { parsePatchDoc, scanPatchDoc } from '../src/patchFile'
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

interface Harness {
  root: string
  profileDir: string
  homeDir: string
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<CapturedResponse>
  setLive(live: unknown): void
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
  const profileDir = join(root, 'profiles', 'desktop')
  const homeDir = join(root, 'home')
  await mkdir(profileDir, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  const registrations = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  let live: unknown = []
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
        return { name: 'desktop', patchPath: join(profileDir, 'cordis.patch.yml'), home: homeDir }
      }
      if (name === 'loader' || name === 'tools') return live
      if (name === 'hmr') return { mark: true }
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
    const handler = registrations.get(path)
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
  return { root, profileDir, homeDir, request, setLive: (value: unknown) => (live = value) }
}

const STDIO_DEMO = `
- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: demo
        command: npx
        args: ['-y', 'pkg']
        reconnect:
          enabled: false
`

let harness: Harness

beforeEach(async () => {
  harness = await makeHarness()
})

afterEach(async () => {
  await rm(harness.root, { recursive: true, force: true })
})

describe('list 路由', () => {
  it('组合两层文件：home 层覆盖 disabled / config，行带作用域', async () => {
    await writeFile(join(harness.profileDir, 'cordis.patch.yml'), `# header\n${STDIO_DEMO}`)
    await writeFile(
      join(harness.homeDir, 'cordis.patch.yml'),
      ['- id: mcp-demo', '  disabled: true', ''].join('\n'),
    )
    const response = await harness.request('GET', '/dsh-mcp/list')
    expect(response.status).toBe(200)
    const servers = response.body.servers as Record<string, unknown>[]
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({ id: 'mcp-demo', scope: 'profile', disabled: true })
    expect(servers[0]?.config).toMatchObject({ transport: 'stdio', serverName: 'demo', command: 'npx' })
    expect(response.body.hotApply).toBe(true)
    expect(response.body.profileName).toBe('desktop')
  })

  it('运行态匹配根树条目，工具按前缀计数；bundle / 未匹配行只读展示', async () => {
    await writeFile(join(harness.profileDir, 'cordis.patch.yml'), STDIO_DEMO)
    harness.setLive({
      entries: () =>
        [
          {
            options: { id: 'mcp-demo', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'demo' } },
            disabled: false,
            fiber: { state: 2, await: async () => {} },
            parent: {},
          },
          {
            options: {
              id: 'bundled',
              name: '@deepseek-ai/dsh-mcp-client',
              config: { serverName: 'bundled' },
            },
            disabled: false,
            fiber: { state: 2, await: async () => {} },
            // bundle 行挂在 cordis-plugin-group 的 Group 子树下（官方判定方式）。
            parent: Object.create(Group.prototype),
          },
          {
            options: { id: 'mcp-overlay', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'ov' } },
            disabled: false,
            fiber: {
              state: 3,
              await: async () => {
                throw new Error('connect ECONNREFUSED')
              },
            },
            parent: {},
          },
        ][Symbol.iterator](),
      schemas: () => [{ name: 'mcp__demo__ping' }, { name: 'mcp__demo__pong' }, { name: 'mcp__bundled__x' }],
    })
    const response = await harness.request('GET', '/dsh-mcp/list')
    const servers = response.body.servers as Record<string, unknown>[]
    const demo = servers.find((row) => row.id === 'mcp-demo')
    expect(demo?.live).toMatchObject({ status: 'active', tools: ['mcp__demo__ping', 'mcp__demo__pong'] })
    const bundled = servers.find((row) => row.id === 'bundled')
    expect(bundled).toMatchObject({ scope: 'bundle', editable: false })
    const overlay = servers.find((row) => row.id === 'mcp-overlay')
    expect(overlay).toMatchObject({ scope: 'overlay', editable: false })
    expect((overlay?.live as Record<string, unknown>).error).toContain('ECONNREFUSED')
  })
})

describe('save 路由', () => {
  it('新建写入目标层并保留文件注释', async () => {
    await writeFile(join(harness.profileDir, 'cordis.patch.yml'), '# 用户手写注释\n[]\n')
    const response = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'profile',
      config: { transport: 'stdio', serverName: 'demo', command: 'node', args: ['server.js'] },
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: 'mcp-demo', scope: 'profile' })
    const text = await readFile(join(harness.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('# 用户手写注释')
    const scanned = scanPatchDoc(parsePatchDoc(text))
    expect(scanned.inserts[0]?.config).toEqual({
      transport: 'stdio',
      serverName: 'demo',
      command: 'node',
      args: ['server.js'],
    })
  })

  it('同名 serverName 或被其他插件行占用的 id 冲突时 409', async () => {
    await writeFile(join(harness.profileDir, 'cordis.patch.yml'), STDIO_DEMO)
    const clashName = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'home',
      config: { transport: 'stdio', serverName: 'demo', command: 'node' },
    })
    expect(clashName.status).toBe(409)
    // 行 id 命名空间跨插件共享：mcp-<serverName> 与其他插件行的 id 冲突也拒绝。
    await writeFile(
      join(harness.profileDir, 'cordis.patch.yml'),
      `- insert:\n    - id: mcp-demo\n      name: someone-else\n`,
    )
    const clashId = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'profile',
      config: { transport: 'stdio', serverName: 'demo', command: 'node' },
    })
    expect(clashId.status).toBe(409)
  })

  it('编辑替换 insert 与所有 config 覆盖行，保留未知键', async () => {
    await writeFile(join(harness.profileDir, 'cordis.patch.yml'), `# header\n${STDIO_DEMO}`)
    await writeFile(
      join(harness.homeDir, 'cordis.patch.yml'),
      ['- id: mcp-demo', '  config: { transport: stdio, serverName: demo, command: override }', ''].join(
        '\n',
      ),
    )
    const response = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'profile',
      id: 'mcp-demo',
      config: { transport: 'streamable-http', serverName: 'demo', url: 'https://x.example/mcp' },
    })
    expect(response.status).toBe(200)
    const profileText = await readFile(join(harness.profileDir, 'cordis.patch.yml'), 'utf8')
    const homeText = await readFile(join(harness.homeDir, 'cordis.patch.yml'), 'utf8')
    expect(profileText).toContain('# header')
    for (const text of [profileText, homeText]) {
      const row = scanPatchDoc(parsePatchDoc(text))
      const config = row.inserts[0]?.config ?? row.overrides[0]?.config
      expect(config).toMatchObject({
        transport: 'streamable-http',
        serverName: 'demo',
        url: 'https://x.example/mcp',
      })
      expect(config).not.toHaveProperty('command')
      expect(config).not.toHaveProperty('args')
      // 未知键 reconnect 原样保留。
      expect(config).toHaveProperty('reconnect')
    }
  })

  it('新建带 disabled：创建即停用（覆盖行承载，config 不保留该键）', async () => {
    const response = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'profile',
      config: { transport: 'stdio', serverName: 'demo', command: 'node' },
      disabled: true,
    })
    expect(response.status).toBe(200)
    const text = await readFile(join(harness.profileDir, 'cordis.patch.yml'), 'utf8')
    const scanned = scanPatchDoc(parsePatchDoc(text))
    expect(scanned.inserts[0]?.config).not.toHaveProperty('disabled')
    expect(text).toContain('- id: mcp-demo\n  disabled: true\n')
  })

  it('编辑带 disabled：与行级启停覆盖行互转', async () => {
    await writeFile(join(harness.profileDir, 'cordis.patch.yml'), STDIO_DEMO)
    const disable = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'profile',
      id: 'mcp-demo',
      config: { transport: 'stdio', serverName: 'demo', command: 'node' },
      disabled: true,
    })
    expect(disable.status).toBe(200)
    expect(await readFile(join(harness.profileDir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: true')
    const enable = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'profile',
      id: 'mcp-demo',
      config: { transport: 'stdio', serverName: 'demo', command: 'node' },
      disabled: false,
    })
    expect(enable.status).toBe(200)
    expect(await readFile(join(harness.profileDir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: false')
  })

  it('disabled 非布尔值 400', async () => {
    const response = await harness.request('POST', '/dsh-mcp/save', {
      scope: 'profile',
      config: { transport: 'stdio', serverName: 'demo', command: 'node' },
      disabled: 'yes',
    })
    expect(response.status).toBe(400)
  })

  it('坏配置 400、未知行 404', async () => {
    expect(
      (
        await harness.request('POST', '/dsh-mcp/save', {
          scope: 'profile',
          config: { transport: 'stdio', serverName: 'x y', command: 'n' },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await harness.request('POST', '/dsh-mcp/save', {
          scope: 'profile',
          id: 'mcp-none',
          config: { transport: 'stdio', serverName: 'x', command: 'n' },
        })
      ).status,
    ).toBe(404)
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
  it('无覆盖行时在 insert 层追加官方形态覆盖行', async () => {
    await writeFile(join(harness.profileDir, 'cordis.patch.yml'), STDIO_DEMO)
    const response = await harness.request('POST', '/dsh-mcp/set-enabled', {
      scope: 'profile',
      id: 'mcp-demo',
      enabled: false,
    })
    expect(response.status).toBe(200)
    const text = await readFile(join(harness.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('- id: mcp-demo\n  disabled: true\n')
  })

  it('已有携带 disabled 的覆盖行时改最后一处', async () => {
    await writeFile(join(harness.profileDir, 'cordis.patch.yml'), STDIO_DEMO)
    await writeFile(
      join(harness.homeDir, 'cordis.patch.yml'),
      ['- id: mcp-demo', '  disabled: true', ''].join('\n'),
    )
    await harness.request('POST', '/dsh-mcp/set-enabled', { scope: 'profile', id: 'mcp-demo', enabled: true })
    const homeText = await readFile(join(harness.homeDir, 'cordis.patch.yml'), 'utf8')
    expect(homeText).toContain('disabled: false')
  })
})

describe('delete 路由', () => {
  it('移除 insert 行与两层所有覆盖行', async () => {
    await writeFile(join(harness.profileDir, 'cordis.patch.yml'), `# header\n${STDIO_DEMO}`)
    await writeFile(
      join(harness.homeDir, 'cordis.patch.yml'),
      ['- id: mcp-demo', '  disabled: true', ''].join('\n'),
    )
    const response = await harness.request('POST', '/dsh-mcp/delete', { scope: 'profile', id: 'mcp-demo' })
    expect(response.status).toBe(200)
    const profileText = await readFile(join(harness.profileDir, 'cordis.patch.yml'), 'utf8')
    const homeText = await readFile(join(harness.homeDir, 'cordis.patch.yml'), 'utf8')
    expect(profileText).toContain('# header')
    expect(profileText).not.toContain('mcp-demo')
    expect(homeText).toBe('[]\n')
  })
})

describe('安全守卫', () => {
  it('非 loopback Host 与跨站 POST 一律 403', async () => {
    const badHost = await harness.request('GET', '/dsh-mcp/list', undefined, { host: 'evil.example:1' })
    expect(badHost.status).toBe(403)
    const crossSite = await harness.request(
      'POST',
      '/dsh-mcp/save',
      { scope: 'profile' },
      { 'sec-fetch-site': 'cross-site' },
    )
    expect(crossSite.status).toBe(403)
  })
})
