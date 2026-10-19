import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only：ctx.webServer 的 Context 声明合并（host-webserver 契约类型）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WebError } from '@deepseek-ai/dsh-web'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { writeTextAtomic } from '@dsh-plugins/shared/patch'
import { upsertWebSearchConfig } from './apply-config'
import { startEndpointServer } from './endpoint'
import { createZhipuReader } from './reader'
import { createZhipuSearch } from './search'
import {
  APPLY_WEB_CONFIG_PATH,
  ENDPOINT_STATUS_PATH,
  KEY_REFS,
  type ApplyWebConfigBody,
  type EndpointStatusView,
} from './shared'

export const inject: string[] = ['credentials', 'webServer']

/** 运行中的端点句柄；启动失败时为 undefined，失败原因进状态视图。 */
interface EndpointRuntime {
  baseUrl: string
  port: number
  close: () => Promise<void>
}

/** 宿主 profile 上下文里本插件需要的面（profileContext 由宿主提供）。 */
interface ProfileContextView {
  patchPath?: string
}

export async function apply(ctx: Context) {
  // 缺席才尝试次选；首选解析失败时继续搜索会悄然切换账户和计费凭据。
  async function resolveKey(): Promise<{ key: string | null; failure: string | undefined }> {
    for (const name of KEY_REFS) {
      try {
        const resolved = await ctx.credentials.resolve(name as CredentialRef)
        if (resolved) return { key: resolved.value, failure: undefined }
      } catch (error) {
        return { key: null, failure: `凭证解析失败（${name}: ${errMsg(error)}）` }
      }
    }
    return { key: null, failure: undefined }
  }

  // 搜索与网页阅读共用一把凭据、同一种失败语义；端点鉴权也验收它。
  const requireKey = async (): Promise<string> => {
    const { key, failure } = await resolveKey()
    if (failure) throw new WebError(failure, 'WEB_PROVIDER_ERROR')
    if (!key) {
      throw new WebError('未配置智谱 Coding Plan API Key（ZAI_CODING_CN_API_KEY）', 'WEB_PROVIDER_ERROR')
    }
    return key
  }
  const search = createZhipuSearch(requireKey)
  const read = createZhipuReader(requireKey)

  // 端点是面板地址的事实源：启动失败不拖垮插件（状态路由照常），
  // 原因原样进面板；状态文件损坏这类须人工介入的故障明确报出。
  let endpoint: EndpointRuntime | undefined
  let endpointFailure: string | null = null
  try {
    const server = await startEndpointServer({
      stateFile: dshHomePath('dsh-zhipu-tools.json'),
      resolveExpectedKey: requireKey,
      search,
      read,
    })
    endpoint = server
    ctx.effect(() => () => void server.close(), 'dsh-zhipu-tools: endpoint server')
  } catch (error) {
    endpointFailure = errMsg(error)
    ctx.logger.error(`dsh-zhipu-tools: 搜索端点启动失败（面板可查看原因）: ${endpointFailure}`)
  }

  const { key: apiKey, failure } = await resolveKey()
  if (failure !== undefined) {
    ctx.logger.error(`dsh-zhipu-tools: ${failure}，智谱能力保持不可用`)
  } else if (apiKey === null) {
    ctx.logger.error('dsh-zhipu-tools: 未配置 zai-coding-cn 供应商，智谱能力保持不可用')
  }

  // profile patch 的并发基线：status 返回 mtime，apply 带回校验；缺 ENOENT 即 null（基线关闭）。
  async function patchMtime(): Promise<number | null> {
    const patchPath = profilePatchPath(ctx)
    if (patchPath === undefined) return null
    try {
      return (await stat(patchPath)).mtimeMs
    } catch {
      return null
    }
  }

  ctx.effect(() => {
    const disposeStatus = ctx.webServer.register({
      kind: 'exact',
      path: ENDPOINT_STATUS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'GET' || !isTrustedFetch(req)) {
          writeJson(res, 403, { error: 'forbidden' })
          return
        }
        // 凭据每次现查：补配后无需重启即反映到面板。
        const { key, failure: credentialFailure } = await resolveKey()
        const view: EndpointStatusView = {
          baseUrl: endpoint?.baseUrl ?? null,
          port: endpoint?.port ?? null,
          failure: endpointFailure,
          credential: {
            configured: key !== null,
            failure: credentialFailure,
          },
          fetchBackend: 'zhipu-reader',
          patchMtimeMs: await patchMtime(),
        }
        writeJson(res, 200, view as unknown as Record<string, unknown>)
      },
    })
    const disposeApply = ctx.webServer.register({
      kind: 'exact',
      path: APPLY_WEB_CONFIG_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          if (!isExpectedHost(req, ctx.webServer.host) || !isTrustedFetch(req)) {
            throw new HttpError(403, 'forbidden')
          }
          if (req.method !== 'POST') throw new HttpError(405, '仅接受 POST')
          if (endpoint === undefined) throw new HttpError(409, '端点未在监听，无法写入配置')
          const patchPath = profilePatchPath(ctx)
          if (patchPath === undefined) throw new HttpError(500, '无法定位 profile patch 文件路径')
          const body = (await readJsonBody(req)) as ApplyWebConfigBody
          const current = await patchMtime()
          if (
            typeof body.expectedMtimeMs === 'number' &&
            current !== null &&
            body.expectedMtimeMs !== current
          ) {
            throw new HttpError(409, 'patch 配置文件已被外部修改，请刷新面板后重试')
          }
          let text: string | null = null
          try {
            text = await readFile(patchPath, 'utf8')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          await writeTextAtomic(patchPath, upsertWebSearchConfig(text, endpoint.baseUrl))
          writeJson(res, 200, { ok: true })
        } catch (error) {
          if (error instanceof HttpError) {
            writeJson(res, error.status, { error: error.message })
            return
          }
          writeJson(res, 500, { error: errMsg(error) })
        }
      },
    })
    return () => {
      disposeStatus()
      disposeApply()
    }
  }, 'dsh-zhipu-tools: panel routes')
}

/** profile patch 文件路径（profileContext 由宿主装配，未就绪时 apply 不可用）。 */
function profilePatchPath(ctx: Context): string | undefined {
  const profile = ctx.get('profileContext') as ProfileContextView | undefined
  const patchPath = profile?.patchPath
  return typeof patchPath === 'string' && patchPath.length > 0 ? patchPath : undefined
}
