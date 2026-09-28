/**
 * host 桥：假 ctx/webServer 上的路由集成往返——守卫（Host / sec-fetch /
 * method）、state / local-rows 读取（临时目录两层 patch）、save 校验、
 * 操作点火的 404/409/400 语义。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyWithEngine } from '../src/index'
import { RemoteEngine } from '../src/engine'
import { isExpectedHost, isTrustedFetch } from '@dsh-plugins/shared/http'

function plainReq(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

function postReq(body: unknown, headers: Record<string, string | string[] | undefined>): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body))
  return {
    headers,
    method: 'POST',
    url: '/',
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  } as unknown as IncomingMessage
}

interface CapturedResponse {
  status: number
  body: Record<string, unknown>
}

function fakeRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  const captured: CapturedResponse = { status: 0, body: {} }
  const res = {
    writeHead(status: number) {
      captured.status = status
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

interface Harness {
  home: string
  profileDir: string
  homeDir: string
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<CapturedResponse>
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-test-'))
  const profileDir = join(root, 'profiles', 'web')
  const homeDir = join(root, 'home')
  await mkdir(profileDir, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    [
      '# 本机 profile 层',
      '- insert:',
      '    - id: dsh-mcp',
      "      name: 'dsh-mcp'",
      '- insert:',
      '    - id: mcp-demo',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config: { transport: stdio, serverName: demo, command: npx }',
      '',
    ].join('\n'),
    'utf8',
  )
  const registrations = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
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
        return { name: 'web', patchPath: join(profileDir, 'cordis.patch.yml'), home: homeDir }
      }
      return undefined
    },
  }
  const engine = new RemoteEngine({
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    startForward: () => ({ kill() {}, onExit() {} }),
    freeLocalPort: async () => 19999,
    healthCheck: async () => true,
    pushTar: async () => {},
    readLocalLayers: async () => [],
    scanSkills: async () => [],
    tools: { ssh: true, tar: true },
    localDshVersion: '0.1.7-rc.2',
    homeDir: root,
    now: () => '2027-01-01T00:00:00.000Z',
    delay: async () => {},
  })
  applyWithEngine(ctx as never, engine)
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
  return { home: root, profileDir, homeDir, request }
}

describe('守卫函数（共享栅栏）', () => {
  it('Host / sec-fetch 语义与 dsh-mcp 一致', () => {
    expect(isExpectedHost(plainReq({ host: '127.0.0.1:8080' }), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(plainReq({ host: 'evil.example:8080' }), '127.0.0.1')).toBe(false)
    expect(isTrustedFetch(plainReq({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(isTrustedFetch(plainReq({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
  })
})

describe('dsh-remote 桥路由', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await makeHarness()
  })

  afterEach(async () => {
    // Windows 上句柄延迟释放会让目录删除报 ENOTEMPTY——带重试兜底
    await rm(harness.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('GET /dsh-remote/state：空连接库 + 本机环境', async () => {
    const response = await harness.request('GET', '/dsh-remote/state')
    expect(response.status).toBe(200)
    expect(response.body.env).toMatchObject({ profileName: 'web', ssh: true, tar: true })
    expect(response.body.connections).toEqual([])
  })

  it('GET /dsh-remote/local-rows：MCP 行与插件行分层标注', async () => {
    const response = await harness.request('GET', '/dsh-remote/local-rows')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ available: true })
    const rows = response.body as unknown as {
      mcpRows: { id: string }[]
      pluginRows: { id: string; name: string }[]
    }
    expect(rows.mcpRows.map((row) => row.id)).toEqual(['mcp-demo'])
    expect(rows.pluginRows.map((row) => row.name)).toEqual(['dsh-mcp'])
  })

  it('POST /dsh-remote/save：新建 + 校验失败 400', async () => {
    const created = await harness.request('POST', '/dsh-remote/save', {
      label: '开发机',
      sshAlias: 'dev-box',
      sync: { mcpServerNames: ['demo'], pluginNames: ['dsh-mcp'] },
    })
    expect(created.status).toBe(200)
    expect(created.body).toEqual({ id: 'dev-box' })

    const invalid = await harness.request('POST', '/dsh-remote/save', {
      label: '',
      sshAlias: 'x',
      sync: { mcpServerNames: [], pluginNames: [] },
    })
    expect(invalid.status).toBe(400)
  })

  it('POST 操作路由：未知 id 404、缺 id 400、坏 kind 400、合法点火 200', async () => {
    await harness.request('POST', '/dsh-remote/save', {
      label: '开发机',
      sshAlias: 'dev-box',
      sync: { mcpServerNames: [], pluginNames: [] },
    })

    expect((await harness.request('POST', '/dsh-remote/deploy', { id: 'nope' })).status).toBe(404)
    expect((await harness.request('POST', '/dsh-remote/deploy', {})).status).toBe(400)
    expect((await harness.request('POST', '/dsh-remote/sync', { id: 'dev-box', kind: 'other' })).status).toBe(
      400,
    )
    const fired = await harness.request('POST', '/dsh-remote/sync', { id: 'dev-box', kind: 'skills' })
    expect(fired.status).toBe(200)
    expect(fired.body).toMatchObject({ started: true })
  })

  it('跨站 sec-fetch 与错误 Host 头拒绝 403', async () => {
    expect(
      (
        await harness.request(
          'POST',
          '/dsh-remote/save',
          { label: 'x', sshAlias: 'x' },
          { 'sec-fetch-site': 'cross-site' },
        )
      ).status,
    ).toBe(403)
    expect(
      (await harness.request('GET', '/dsh-remote/state', undefined, { host: 'evil.example:1' })).status,
    ).toBe(403)
    expect((await harness.request('POST', '/dsh-remote/state', {})).status).toBe(403)
  })
})
