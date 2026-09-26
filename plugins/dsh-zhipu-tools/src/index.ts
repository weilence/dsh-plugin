import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
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

function errMsg(error: unknown) {
  const message = (error as { message?: string } | null | undefined)?.message
  return message || String(error)
}

// isLoopbackHostname / isTrusted 导出仅为单测（纯函数）。
export function isLoopbackHostname(hostname: string) {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

// IPv6 字面量带端口形如 [::1]:3080，先取 ] 前闭区间；其余按首个 : 切分。
function hostnameOf(host: string) {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(0, end + 1)
  }
  return host.split(':')[0]
}

// 只放行 loopback 同源请求，拒绝跨站读取用量。
export function isTrusted(req: IncomingMessage) {
  const host = req.headers.host
  if (!host) return false
  const hostname = hostnameOf(host)
  if (!isLoopbackHostname(hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return typeof origin === 'string' && new URL(origin).host === host
  } catch {
    return false
  }
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function apply(ctx: Context) {
  async function resolveKey() {
    for (const name of KEY_REFS) {
      try {
        const resolved = await ctx.credentials.resolve(name as CredentialRef)
        if (resolved) return resolved.value
      } catch {}
    }
    return null
  }

  const apiKey: string | null = await resolveKey()
  if (!apiKey) {
    ctx.logger?.error?.('dsh-zhipu-tools: 未配置 zai-coding-cn 供应商，智谱能力保持不可用')
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
        ctx.logger?.info?.(`dsh-zhipu-tools: MCP ${server.serverName} 已挂载（in-box mcp-client）`)
      } catch (error) {
        ctx.logger?.error?.(
          `dsh-zhipu-tools: MCP ${server.serverName} 挂载失败（仅该服务器工具不可用）: ${errMsg(error)}`,
        )
      }
    }
  }

  const usage = createUsageService(apiKey)
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-zhipu-tools/usage',
        handler: async (req, res) => {
          if (!isTrusted(req)) {
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

export { apply }
