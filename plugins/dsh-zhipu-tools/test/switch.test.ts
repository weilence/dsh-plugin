/** 搜索替换开关：假 ctx/webServer 上的两路由集成往返（临时目录落盘）。 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply } from '../src/index'
import { switchViewOf } from '../src/index'
import { hasCliPatchArg } from '../src/live'
import { SWITCH_SET_PATH, SWITCH_STATE_PATH } from '../src/shared'
import { emptyPatchDoc, parsePatchDoc } from '@dsh-plugins/shared/patch'

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
  /** 替换 loader / hmr 内省桩。 */
  setLive(loader: unknown, hmr: boolean): void
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

/** loader 桩：返回给定的条目列表。 */
function loaderOf(entries: unknown[]): unknown {
  return { entries: () => entries[Symbol.iterator]() }
}

const WEB_ENTRY = (
  searchProvider: string | undefined,
  options: { disabled?: boolean; subtree?: boolean } = {},
) => ({
  options: {
    id: 'web',
    name: '@deepseek-ai/dsh-web',
    config: searchProvider === undefined ? {} : { searchProvider, fetchProvider: 'http' },
  },
  disabled: options.disabled ?? false,
  // 默认根树（bundle 子树条目传 subtree: true，模拟包自带 patch 来源）。
  parent: options.subtree ? { subtree: {}, parent: {} } : {},
})

async function makeHarness(
  resolve: (name: string) => Promise<unknown> = async () => undefined,
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-zhipu-switch-'))
  const profileDir = join(root, 'profiles', 'desktop')
  const homeDir = join(root, 'home')
  await mkdir(profileDir, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  const registrations = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  let loader: unknown = undefined
  let hmr = true
  const ctx = {
    credentials: { resolve },
    plugin: async () => {},
    web: { registerSearchProvider: () => {} },
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
      if (name === 'loader') return loader
      if (name === 'hmr') return hmr ? { mark: true } : undefined
      return undefined
    },
    logger: { error: () => {}, info: () => {} },
  }
  await apply(ctx as never)
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
  return {
    root,
    profileDir,
    homeDir,
    request,
    setLive: (nextLoader: unknown, nextHmr: boolean) => {
      loader = nextLoader
      hmr = nextHmr
    },
  }
}

let harness: Harness

beforeEach(async () => {
  harness = await makeHarness()
})

afterEach(async () => {
  await rm(harness.root, { recursive: true, force: true })
})

describe('GET search-switch', () => {
  it('默认（两层无 web 行、生效值来自 bundle 子树）：关、可编辑、将新建于 home', async () => {
    harness.setLive(loaderOf([WEB_ENTRY('deepseek-official', { subtree: true })]), true)
    const response = await harness.request('GET', SWITCH_STATE_PATH)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      active: false,
      editable: true,
      fileProvider: null,
      effectiveProvider: 'deepseek-official',
      hotApply: true,
      writeTarget: 'create:home',
    })
  })

  it('摊平挂载的根树条目（宿主 bootstrap include）且无 CLI 覆盖：按 bundle 来源，可编辑', async () => {
    harness.setLive(loaderOf([WEB_ENTRY('deepseek-official')]), true)
    const response = await harness.request('GET', SWITCH_STATE_PATH)
    expect(response.body).toMatchObject({ editable: true, active: false, writeTarget: 'create:home' })
  })

  it('运行时已是智谱且与文件一致：开、就地改 home', async () => {
    await writeFile(
      join(harness.homeDir, 'cordis.patch.yml'),
      '- id: web\n  config:\n    searchProvider: zhipu\n    fetchProvider: http\n',
    )
    harness.setLive(loaderOf([WEB_ENTRY('zhipu')]), true)
    const response = await harness.request('GET', SWITCH_STATE_PATH)
    expect(response.body).toMatchObject({ active: true, editable: true, writeTarget: 'in-place:home' })
  })

  it('profile 层有生效行时就地改 profile；home 层行压住 profile 行时改 home', async () => {
    await writeFile(
      join(harness.profileDir, 'cordis.patch.yml'),
      '- id: web\n  config:\n    searchProvider: exa\n',
    )
    harness.setLive(loaderOf([WEB_ENTRY('exa')]), true)
    expect((await harness.request('GET', SWITCH_STATE_PATH)).body).toMatchObject({
      fileProvider: 'exa',
      writeTarget: 'in-place:profile',
    })
    await writeFile(
      join(harness.homeDir, 'cordis.patch.yml'),
      '- id: web\n  config:\n    searchProvider: exa\n',
    )
    expect((await harness.request('GET', SWITCH_STATE_PATH)).body).toMatchObject({
      writeTarget: 'in-place:home',
    })
  })

  it('loader 在场但无 web 行：不可编辑并说明', async () => {
    harness.setLive(loaderOf([]), true)
    const response = await harness.request('GET', SWITCH_STATE_PATH)
    expect(response.body).toMatchObject({ editable: false })
    expect(response.body.effectiveProvider).toBeUndefined()
    expect(response.body.reason).toContain('web 服务未在当前组合中加载')
  })

  it('web 行被停用（disabled）：不可编辑并提示先恢复启用', async () => {
    harness.setLive(loaderOf([WEB_ENTRY('deepseek-official', { subtree: true, disabled: true })]), true)
    const response = await harness.request('GET', SWITCH_STATE_PATH)
    expect(response.body).toMatchObject({ editable: false, active: false })
    expect(response.body.reason).toContain('被停用')
  })

  it('loader 不可用：降级为文件推算且仍可编辑', async () => {
    await writeFile(
      join(harness.homeDir, 'cordis.patch.yml'),
      '- id: web\n  config:\n    searchProvider: zhipu\n',
    )
    harness.setLive(undefined, false)
    const response = await harness.request('GET', SWITCH_STATE_PATH)
    expect(response.body).toMatchObject({ active: true, editable: true, hotApply: false })
    expect(response.body.effectiveProvider).toBeUndefined()
  })

  it('非 profile 启动（无 profileContext）：503', async () => {
    const registrations = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
    const ctx = {
      credentials: { resolve: async () => undefined },
      plugin: async () => {},
      web: { registerSearchProvider: () => {} },
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
      get: () => undefined,
      logger: { error: () => {}, info: () => {} },
    }
    await apply(ctx as never)
    const { res, done } = fakeRes()
    await registrations.get(SWITCH_STATE_PATH)!(
      { headers: { host: '127.0.0.1:19387' }, method: 'GET' } as never,
      res,
    )
    expect((await done).status).toBe(503)
  })
})

describe('POST search-switch/set', () => {
  it('两层无 web 行时开启（bundle 来源）：以运行时生效配置为底在 home 新建托管行', async () => {
    harness.setLive(loaderOf([WEB_ENTRY('deepseek-official', { subtree: true })]), true)
    const response = await harness.request('POST', SWITCH_SET_PATH, { enabled: true })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ enabled: true, scope: 'home', written: true })
    const text = await readFile(join(harness.homeDir, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('dsh-zhipu-tools managed')
    expect(text).toContain('searchProvider: zhipu')
    // 运行时生效配置整体保留，不丢 fetchProvider。
    expect(text).toContain('fetchProvider: http')
  })

  it('profile 层已有生效行时开启：就地只改 searchProvider 并记录原值', async () => {
    await writeFile(
      join(harness.profileDir, 'cordis.patch.yml'),
      "# 我的搜索配置\n- id: web\n  name: '@deepseek-ai/dsh-web'\n  config:\n    searchProvider: exa\n    fetchProvider: http\n",
    )
    harness.setLive(loaderOf([WEB_ENTRY('exa')]), true)
    const response = await harness.request('POST', SWITCH_SET_PATH, { enabled: true })
    expect(response.body).toEqual({ enabled: true, scope: 'profile', written: true })
    const text = await readFile(join(harness.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('# 我的搜索配置')
    expect(text).toContain('# dsh-zhipu-tools previous: exa')
    expect(text).toContain('searchProvider: zhipu')
    expect(text).toContain('fetchProvider: http')
  })

  it('关闭托管行：整行删除回落低层当前值', async () => {
    harness.setLive(loaderOf([WEB_ENTRY('deepseek-official', { subtree: true })]), true)
    await harness.request('POST', SWITCH_SET_PATH, { enabled: true })
    const outcome = await harness.request('POST', SWITCH_SET_PATH, { enabled: false })
    expect(outcome.body).toEqual({ enabled: false, scope: 'home', written: true })
    const text = await readFile(join(harness.homeDir, 'cordis.patch.yml'), 'utf8')
    expect(text).toBe('[]\n')
  })

  it('关闭就地行：恢复原值；再关闭为幂等空操作', async () => {
    await writeFile(
      join(harness.profileDir, 'cordis.patch.yml'),
      '- id: web\n  config:\n    searchProvider: deepseek-official\n    fetchProvider: http\n',
    )
    harness.setLive(loaderOf([WEB_ENTRY('deepseek-official')]), true)
    await harness.request('POST', SWITCH_SET_PATH, { enabled: true })
    const outcome = await harness.request('POST', SWITCH_SET_PATH, { enabled: false })
    expect(outcome.body).toEqual({ enabled: false, scope: 'profile', written: true })
    const text = await readFile(join(harness.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('searchProvider: deepseek-official')
    expect(text).not.toContain('dsh-zhipu-tools')
    const again = await harness.request('POST', SWITCH_SET_PATH, { enabled: false })
    expect(again.body).toEqual({ enabled: false, scope: 'profile', written: false })
  })

  it('不可编辑状态拒绝写入并携带原因', async () => {
    harness.setLive(loaderOf([]), true)
    const response = await harness.request('POST', SWITCH_SET_PATH, { enabled: true })
    expect(response.status).toBe(409)
    expect(response.body.error).toContain('web 服务未在当前组合中加载')
  })

  it('enabled 非布尔值拒绝；写盘文件解析失败报 500', async () => {
    harness.setLive(loaderOf([WEB_ENTRY('deepseek-official', { subtree: true })]), true)
    const invalid = await harness.request('POST', SWITCH_SET_PATH, { enabled: 'yes' })
    expect(invalid.status).toBe(400)
    await writeFile(join(harness.homeDir, 'cordis.patch.yml'), '- id: [broken\n')
    const broken = await harness.request('GET', SWITCH_STATE_PATH)
    expect(broken.status).toBe(500)
    expect(String(broken.body.error)).toContain('解析失败')
  })

  it('跨站请求拒绝', async () => {
    const response = await harness.request(
      'POST',
      SWITCH_SET_PATH,
      { enabled: true },
      {
        'sec-fetch-site': 'cross-site',
      },
    )
    expect(response.status).toBe(403)
  })
})

describe('switchViewOf 来源判定（CLI 覆盖分支）', () => {
  const layersOf = (homePatch?: string) => [
    { scope: 'profile' as const, file: '/profile/cordis.patch.yml', doc: parsePatchDoc('[]\n') },
    {
      scope: 'home' as const,
      file: '/home/cordis.patch.yml',
      doc: parsePatchDoc(homePatch ?? '[]\n'),
    },
  ]
  const ctxOf = (loader: unknown) =>
    ({
      get: (name: string): unknown =>
        name === 'loader' ? loader : name === 'hmr' ? { mark: true } : undefined,
    }) as never

  it('进程带 --patch 且两层无 web 行：摊平条目判为 CLI 来源，不可编辑', () => {
    const view = switchViewOf(ctxOf(loaderOf([WEB_ENTRY('deepseek-official')])), layersOf(), true)
    expect(view).toMatchObject({ editable: false, active: false, fileProvider: null })
    expect(view.reason).toContain('--patch')
  })

  it('--patch 在场但文件已有 web 行：仍按文件就地改，被覆盖由写入后的运行时比对暴露', () => {
    const view = switchViewOf(
      ctxOf(loaderOf([WEB_ENTRY('exa')])),
      layersOf('- id: web\n  config:\n    searchProvider: exa\n'),
      true,
    )
    expect(view).toMatchObject({ editable: true, writeTarget: 'in-place:home', fileProvider: 'exa' })
  })

  it('hasCliPatchArg 识别 --patch 的两种写法', () => {
    expect(hasCliPatchArg(['dsh', 'web', '--patch', '/tmp/x.yml'])).toBe(true)
    expect(hasCliPatchArg(['dsh', 'web', '--patch=/tmp/x.yml'])).toBe(true)
    expect(hasCliPatchArg(['dsh', 'web', '--patches=1'])).toBe(false)
    expect(hasCliPatchArg(['dsh', 'web'])).toBe(false)
  })
})
