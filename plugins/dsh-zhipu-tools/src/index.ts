import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only：ctx.webServer 的 Context 声明合并（host-webserver 契约类型）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { WebError } from '@deepseek-ai/dsh-web'
import { errMsg } from '@dsh-plugins/shared'
import { isExpectedHost, isTrustedFetch, writeJson } from '@dsh-plugins/shared/http'
import { startEndpointServer } from './endpoint'
import { createZhipuReader } from './reader'
import { createZhipuSearch } from './search'
import { ENDPOINT_STATUS_PATH, KEY_REFS, type EndpointStatusView } from './shared'

export const inject: string[] = ['credentials', 'tools', 'webServer']

// serverName → 模型侧工具名 mcp__<serverName>__<rawName>；
// 须匹配 in-box 的 /^[A-Za-z0-9_-]{1,32}$/ 且全局唯一。
interface McpServerSpec {
  serverName: string
  url: string
  callTimeoutMs: number
}

// 搜索 MCP 与端点搜索并存：前者向模型暴露 search_query 之外的域过滤、
// 时效等参数，后者只承接官方 web_search 的简化入参。
const MCP_SERVERS: readonly McpServerSpec[] = [
  {
    serverName: 'zhipu_search',
    url: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
    callTimeoutMs: 30_000,
  },
  {
    serverName: 'zhipu_reader',
    url: 'https://open.bigmodel.cn/api/mcp/web_reader/mcp',
    callTimeoutMs: 60_000,
  },
]

// 只取挂载所需的三个导出；整个命名空间传给 ctx.plugin 可能把 Config 误当配置 schema。
const MCP_CLIENT_PLUGIN = {
  name: mcpClient.name,
  inject: mcpClient.inject,
  apply: mcpClient.apply,
}

/** 运行中的端点句柄；启动失败时为 undefined，失败原因进状态视图。 */
interface EndpointRuntime {
  baseUrl: string
  port: number
  token: string
  close: () => Promise<void>
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

  // 端点是面板地址的事实源：启动失败不拖垮插件（MCP 与状态路由照常），
  // 原因原样进面板；状态文件损坏这类须人工介入的故障明确报出。
  let endpoint: EndpointRuntime | undefined
  let endpointFailure: string | null = null
  try {
    const server = await startEndpointServer({
      stateFile: dshHomePath('dsh-zhipu-tools.json'),
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

  // 重连与工具同步由 in-box mcp-client 承担；单个服务器失败只记日志、不
  // 阻塞插件激活，也不影响端点搜索。
  const mcpMounted = new Map<string, boolean>()
  if (apiKey) {
    for (const server of MCP_SERVERS) {
      try {
        const config: StreamableHttpConfig = {
          transport: 'streamable-http',
          serverName: server.serverName,
          url: server.url,
          headers: { Authorization: `Bearer ${apiKey}` },
          toolCallTimeoutMs: server.callTimeoutMs,
          failOnStartupError: false,
        }
        await ctx.plugin(MCP_CLIENT_PLUGIN, config)
        mcpMounted.set(server.serverName, true)
        ctx.logger.info(`dsh-zhipu-tools: MCP ${server.serverName} 已挂载（in-box mcp-client）`)
      } catch (error) {
        mcpMounted.set(server.serverName, false)
        ctx.logger.error(
          `dsh-zhipu-tools: MCP ${server.serverName} 挂载失败（仅该服务器工具不可用）: ${errMsg(error)}`,
        )
      }
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
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
            token: endpoint?.token ?? null,
            failure: endpointFailure,
            credential: {
              configured: key !== null,
              failure: credentialFailure,
            },
            fetchBackend: 'zhipu-reader',
            mcp: MCP_SERVERS.map((server) => ({
              server: server.serverName,
              mounted: mcpMounted.get(server.serverName) ?? false,
            })),
          }
          writeJson(res, 200, view as unknown as Record<string, unknown>)
        },
      }),
    'dsh-zhipu-tools: endpoint status',
  )
}
