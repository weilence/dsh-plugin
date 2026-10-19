import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only：ctx.configEditor 的 Context 声明合并（dsh-config-editor 契约类型）。
import type {} from '@deepseek-ai/dsh-config-editor'
// Type-only：ctx.webServer 的 Context 声明合并（host-webserver 契约类型）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WebError } from '@deepseek-ai/dsh-web'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isExpectedHost, isTrustedFetch, writeJson } from '@dsh-plugins/shared/http'
import { ZhipuFetchProvider, ZhipuSearchProvider } from './providers'
import { createZhipuReader } from './reader'
import { createZhipuSearch } from './search'
import {
  APPLY_WEB_CONFIG_PATH,
  FETCH_PROVIDER_ID,
  KEY_REFS,
  SEARCH_PROVIDER_ID,
  STATUS_PATH,
  type StatusView,
} from './shared'

export const inject: string[] = ['credentials', 'web', 'webServer', 'configEditor']

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

  // 搜索与网页阅读共用一把凭据、同一种失败语义。
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

  // available() 须同步且不发网络：凭据在场性用快照表达，状态路由每次读取时刷新。
  let credentialReady = false
  async function probeCredential(): Promise<{ key: string | null; failure: string | undefined }> {
    const resolved = await resolveKey()
    credentialReady = resolved.key !== null
    return resolved
  }

  // 注册随本插件 fiber 生灭：HMR 重载自动换新，卸载即从注册表消失。
  ctx.effect(() => {
    const disposeSearch = ctx.web.registerSearchProvider(
      new ZhipuSearchProvider(search, () => credentialReady),
    )
    const disposeFetch = ctx.web.registerFetchProvider(new ZhipuFetchProvider(read, () => credentialReady))
    return () => {
      disposeSearch()
      disposeFetch()
    }
  }, 'dsh-zhipu-tools: web providers')

  const { key: apiKey, failure } = await probeCredential()
  if (failure !== undefined) {
    ctx.logger.error(`dsh-zhipu-tools: ${failure}，智谱 provider 保持不可用`)
  } else if (apiKey === null) {
    ctx.logger.error('dsh-zhipu-tools: 未配置 zai-coding-cn 供应商，智谱 provider 保持不可用')
  }

  // 一键写入：web 行点名本插件的两个 provider；旧版按钮写过的 web-deepseek-api
  // 覆盖行清掉回退部署默认。走官方 configEditor：文件锁、HMR 串行、schema 校验、
  // home 层覆盖检测、原子写与失败回滚全部白拿，不手写 patch 文件。
  async function applyWebConfig(): Promise<void> {
    const entries = ctx.configEditor.entries()
    const legacy = entries.find((entry) => entry.options.id === 'web-deepseek-api')
    const web = entries.find((entry) => entry.options.id === 'web')
    if (web === undefined) throw new HttpError(409, 'web 插件行不可寻址，无法写入 provider 选择')
    if (legacy !== undefined) {
      // next 与 inherited 相等即 configEditor 的官方清除语义：行的 config 删除，行本身可消。
      await ctx.configEditor.edit(legacy, (_current, inherited) => inherited)
    }
    await ctx.configEditor.edit(web, (current) => ({
      ...current,
      searchProvider: SEARCH_PROVIDER_ID,
      fetchProvider: FETCH_PROVIDER_ID,
    }))
  }

  ctx.effect(() => {
    const disposeStatus = ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'GET' || !isTrustedFetch(req)) {
          writeJson(res, 403, { error: 'forbidden' })
          return
        }
        // 凭据每次现查：顺带刷新 provider 的 available() 快照，补配后无需重启。
        const { key, failure: credentialFailure } = await probeCredential()
        const view: StatusView = {
          credential: {
            configured: key !== null,
            failure: credentialFailure,
          },
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
          await applyWebConfig()
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
