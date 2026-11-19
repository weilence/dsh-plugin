import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { runGlab } from './glab'
import { buildTools } from './tools'
import { createSitesManager, validateSiteDraft, type SitesManager, type SitesManagerOptions } from './sites'
import {
  CWD_PATH,
  DELETE_PATH,
  hostOf,
  SAVE_PATH,
  SITES_PATH,
  TEST_PATH,
  type CwdRequest,
  type DeleteRequest,
  type GlabStatusView,
  type SaveRequest,
  type SiteDraft,
  type TestRequest,
  type TestResponse,
} from './shared'

export interface ApplyOptions {
  /** 测试注入：替身 glab 执行（工具与「测试连接」共用 spawn 语义）。 */
  runGlab?: typeof runGlab
  /** 测试注入：跳过真实 glab 二进制探测。 */
  glab?: GlabStatusView
}

export const inject: string[] = ['tools', 'webServer', 'configEditor']

/**
 * GitLab 集成的 host half：多站点配置（本插件行 config）+ glab 二进制探测，
 * 注册一个 glab 透传模型工具，另挂五条设置面板路由（sites / cwd 桥 / save /
 * delete / test）。认证不由插件代管：glab 使用用户自己的登录态，插件只注入
 * GITLAB_HOST 选站；「测试连接」探测认证是否有效，让用户自行处理。
 */
export async function apply(ctx: Context, options: ApplyOptions = {}): Promise<void> {
  const run = options.runGlab ?? runGlab
  const managerOptions: SitesManagerOptions = { run }
  if (options.glab !== undefined) managerOptions.glab = options.glab
  const sites = createSitesManager(ctx, managerOptions)
  await sites.refresh()

  // when 同步读快照：glab 不可用或没有任何站点时，工具整体不进模型面。
  ctx.effect(() => {
    const disposers = buildTools({
      requireSite: (name) => sites.requireSite(name),
      glabPath: () => {
        const path = sites.glabStatus().path
        if (path === null) throw new Error('glab 可执行文件不可用：请到设置页查看 GitLab 分区的 glab 状态')
        return path
      },
    }).map((tool) => ctx.tools.register(tool, { when: () => sites.usable() }))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-gitlab: glab tool')

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SITES_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'GET') {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            // list 请求携带 cwd 兜底（dsh-mcp 同模式）：client 订阅推送缺席时也有工作区。
            const cwd = cwdOf(new URL(req.url ?? '/', 'http://localhost').searchParams.get('cwd'))
            if (cwd !== undefined) sites.setWorkspaceCwd(cwd)
            writeJson(res, 200, (await sites.view()) as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-gitlab: sites route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: CWD_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST') {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = (await readJsonBody(req)) as unknown as CwdRequest
            sites.setWorkspaceCwd(cwdOf(body.cwd))
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-gitlab: cwd bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SAVE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = (await readJsonBody(req)) as unknown as SaveRequest
            const site = validateSiteDraft(body.site)
            if (body.previousName !== undefined && typeof body.previousName !== 'string') {
              throw new HttpError(400, 'previousName 必须是字符串')
            }
            await sites.save({ site, previousName: body.previousName })
            writeJson(res, 200, (await sites.view()) as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-gitlab: save route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DELETE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = (await readJsonBody(req)) as unknown as DeleteRequest
            if (typeof body.name !== 'string' || body.name === '') throw new HttpError(400, '缺少站点名')
            await sites.remove(body.name)
            writeJson(res, 200, (await sites.view()) as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-gitlab: delete route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: TEST_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = (await readJsonBody(req)) as unknown as TestRequest
            const site = validateSiteDraft(body.site)
            // 探测失败是结论而不是异常：200 + ok/reason 交给面板。
            writeJson(res, 200, (await testSite(sites, site, run)) as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-gitlab: test route',
  )
}

/** 请求里的 cwd：空白或缺失 = 工作区未定。 */
function cwdOf(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined
}

const TEST_TIMEOUT_MS = 15_000
const TEST_REASON_CHARS = 400

/** 连接测试：`glab api user --hostname <host>` 探测用户自己的 glab 登录态是否有效。 */
export async function testSite(
  sites: Pick<SitesManager, 'glabStatus'>,
  site: SiteDraft,
  run: typeof runGlab,
): Promise<TestResponse> {
  const status = sites.glabStatus()
  if (status.path === null) return { ok: false, reason: status.error ?? '未找到 glab 可执行文件' }
  let host: string
  try {
    host = hostOf(site.url)
  } catch (error) {
    return { ok: false, reason: errMsg(error) }
  }
  const result = await run({
    glabPath: status.path,
    args: ['api', 'user', '--hostname', host],
    timeoutMs: TEST_TIMEOUT_MS,
    env: { ...process.env },
  })
  if (result.exitCode !== 0) {
    const detail = (result.stderr !== '' ? result.stderr : result.stdout).trim()
    const clipped = detail.length > TEST_REASON_CHARS ? `${detail.slice(0, TEST_REASON_CHARS)}…` : detail
    return { ok: false, reason: clipped === '' ? `glab 退出码 ${result.exitCode}` : clipped }
  }
  try {
    const parsed = JSON.parse(result.stdout) as { username?: string; name?: string }
    const user = parsed.username ?? parsed.name
    return { ok: true, user: user ?? '（已认证，无法解析用户名）' }
  } catch {
    return { ok: true, user: '（已认证）' }
  }
}
