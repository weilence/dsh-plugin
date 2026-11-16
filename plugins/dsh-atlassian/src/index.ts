import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { createConfluenceClient } from './confluence'
import { createJiraClient } from './jira'
import { registerCommands } from './commands'
import { buildTools } from './tools'
import { createSitesManager, validateSiteDraft, type SitesManager } from './sites'
import {
  confluenceProductOf,
  jiraProductOf,
  CLEAR_TOKEN_PATH,
  CWD_PATH,
  DELETE_PATH,
  SAVE_PATH,
  SITES_PATH,
  TEST_PATH,
  type ClearTokenRequest,
  type CwdRequest,
  type DeleteRequest,
  type ProductCheck,
  type SaveRequest,
  type TestRequest,
  type TestResponse,
} from './shared'

export const inject: string[] = ['credentials', 'tools', 'commands', 'webServer', 'configEditor']

/**
 * Atlassian 集成的 host half：多站点配置（本插件行 config）+ 凭据（宿主凭据库，
 * 引用名可回落环境变量），注册四个只读模型工具与 /jira、/conf 两个斜杠命令，
 * 另挂六条设置面板路由（sites / cwd 桥 / save / delete / clear-token / test）。
 * 所有读写均为现读现解析，不在进程里长期持有 token。
 */
export async function apply(ctx: Context): Promise<void> {
  const sites = createSitesManager(ctx)
  await sites.refresh()

  // when 同步读快照：没有任何站点配置好凭据时，四个工具整体不进模型面。
  ctx.effect(() => {
    const disposers = buildTools(sites).map((tool) =>
      ctx.tools.register(tool, { when: () => sites.usableCount() > 0 }),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-atlassian: read tools')

  ctx.effect(() => {
    registerCommands(ctx)
    return () => {}
  }, 'dsh-atlassian: commands')

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
    'dsh-atlassian: sites route',
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
    'dsh-atlassian: cwd bridge',
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
            if (body.token !== undefined && typeof body.token !== 'string') {
              throw new HttpError(400, 'token 必须是字符串')
            }
            if (body.confluenceToken !== undefined && typeof body.confluenceToken !== 'string') {
              throw new HttpError(400, 'confluenceToken 必须是字符串')
            }
            if (body.confluenceToken !== undefined && site.kind !== 'server') {
              throw new HttpError(400, 'cloud 站点两产品共用一份 Atlassian token，不接受 confluenceToken')
            }
            if (body.previousName !== undefined && typeof body.previousName !== 'string') {
              throw new HttpError(400, 'previousName 必须是字符串')
            }
            await sites.save({
              site,
              token: body.token,
              confluenceToken: body.confluenceToken,
              previousName: body.previousName,
            })
            writeJson(res, 200, (await sites.view()) as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-atlassian: save route',
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
    'dsh-atlassian: delete route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: CLEAR_TOKEN_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = (await readJsonBody(req)) as unknown as ClearTokenRequest
            if (typeof body.name !== 'string' || body.name === '') throw new HttpError(400, '缺少站点名')
            const product = body.product ?? 'jira'
            if (product !== 'jira' && product !== 'confluence') {
              throw new HttpError(400, 'product 必须是 jira 或 confluence')
            }
            await sites.clearToken(body.name, product)
            writeJson(res, 200, (await sites.view()) as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-atlassian: clear-token route',
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
            if (body.token !== undefined && typeof body.token !== 'string') {
              throw new HttpError(400, 'token 必须是字符串')
            }
            if (body.confluenceToken !== undefined && typeof body.confluenceToken !== 'string') {
              throw new HttpError(400, 'confluenceToken 必须是字符串')
            }
            // 探测失败是结论而不是异常：200 + 每个 product 的 ok/reason 交给面板。
            writeJson(
              res,
              200,
              (await testSite(sites, site, body.token, body.confluenceToken)) as unknown as Record<
                string,
                unknown
              >,
            )
          } catch (error) {
            writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-atlassian: test route',
  )
}

/** 请求里的 cwd：空白或缺失 = 工作区未定。 */
function cwdOf(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined
}

/** 连接测试：Jira / Confluence 各探测一次轻量端点，凭据按产品独立解析，结果逐产品呈现。 */
async function testSite(
  sites: SitesManager,
  site: ReturnType<typeof validateSiteDraft>,
  jiraTokenOverride?: string,
  confluenceTokenOverride?: string,
): Promise<TestResponse> {
  const jiraToken = jiraTokenOverride ?? (await sites.jiraTokenOf(site))
  const confluenceToken = confluenceTokenOverride ?? (await sites.confluenceTokenOf(site))
  const jira = createJiraClient(jiraProductOf(site), jiraToken)
  const confluence = createConfluenceClient(confluenceProductOf(site), confluenceToken)
  const signal = AbortSignal.timeout(15_000)
  const check = async (probe: (signal: AbortSignal) => Promise<void>): Promise<ProductCheck> => {
    try {
      await probe(signal)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: errMsg(error) }
    }
  }
  return {
    jira: await check((probeSignal) => jira.myself(probeSignal)),
    confluence: await check((probeSignal) => confluence.spacesProbe(probeSignal)),
  }
}
