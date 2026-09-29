import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { errMsg } from '@dsh-plugins/shared'
import { isExpectedHost, writeJson } from '@dsh-plugins/shared/http'
import { createUsageService } from './usage'

export const inject: string[] = ['webServer', 'credentials', 'tools']

// serverName → 模型侧工具名 mcp__<serverName>__<rawName>；
// 须匹配 in-box 的 /^[A-Za-z0-9_-]{1,32}$/ 且全局唯一。
interface McpServerSpec {
  serverName: string
  url: string
  callTimeoutMs: number
}

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

// 两个候选名是编译期常量、满足 POSIX 标识符规则，直接断言（用官方
// credentialRef() 构造需把 in-box 包拉进运行时 bundle，不值得）。
const KEY_REFS = ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'] as const

export async function apply(ctx: Context) {
  // 两个候选都缺失才是「未配置」；resolve 抛错是凭证服务故障，归并成
  // 「未配置」会掩盖真实原因。
  async function resolveKey(): Promise<{ key: string | null; failure: string | undefined }> {
    const errors: string[] = []
    for (const name of KEY_REFS) {
      try {
        const resolved = await ctx.credentials.resolve(name as CredentialRef)
        if (resolved) return { key: resolved.value, failure: undefined }
      } catch (error) {
        errors.push(`${name}: ${errMsg(error)}`)
      }
    }
    return {
      key: null,
      failure: errors.length > 0 ? `凭证解析失败（${errors.join('；')}）` : undefined,
    }
  }

  const { key: apiKey, failure } = await resolveKey()
  if (failure !== undefined) {
    ctx.logger.error(`dsh-zhipu-tools: ${failure}，智谱能力保持不可用`)
  } else if (apiKey === null) {
    ctx.logger.error('dsh-zhipu-tools: 未配置 zai-coding-cn 供应商，智谱能力保持不可用')
  }

  // 用编程式挂载（ctx.plugin）而非静态配置行：headers 需在 apply 时由
  // credentials 服务解析，配置行的 headers 只能读 process.env；重连与 tool
  // resync 由 in-box 承担。
  if (apiKey) {
    for (const server of MCP_SERVERS) {
      try {
        // 首连失败由 in-box 记日志并按 reconnect 策略重试，不阻塞本插件激活。
        const config: StreamableHttpConfig = {
          transport: 'streamable-http',
          serverName: server.serverName,
          url: server.url,
          headers: { Authorization: `Bearer ${apiKey}` },
          toolCallTimeoutMs: server.callTimeoutMs,
          failOnStartupError: false,
        }
        await ctx.plugin(MCP_CLIENT_PLUGIN, config)
        ctx.logger.info(`dsh-zhipu-tools: MCP ${server.serverName} 已挂载（in-box mcp-client）`)
      } catch (error) {
        ctx.logger.error(
          `dsh-zhipu-tools: MCP ${server.serverName} 挂载失败（仅该服务器工具不可用）: ${errMsg(error)}`,
        )
      }
    }
  }

  const usage = createUsageService(apiKey, failure)
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-zhipu-tools/usage',
        handler: async (req, res) => {
          // 与 dsh-remote/dsh-mcp 的读路由相同的请求校验：Host 匹配绑定地址（loopback 拼写等价）且仅放行 GET。
          if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'GET') {
            writeJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          try {
            const url = new URL(req.url ?? '/', 'http://dsh.internal')
            const force = url.searchParams.get('force') === '1'
            writeJson(res, 200, await usage.fetchUsage(force))
          } catch (error) {
            writeJson(res, 500, { ok: false, error: errMsg(error) })
          }
        },
      }),
    'dsh-zhipu-tools: /dsh-zhipu-tools/usage route',
  )
}
