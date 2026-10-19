/**
 * 本地「DeepSeek Web Tools API」兼容端点：宿主内置 web 搜索设置里的
 * Search / Fetch API base URL 指到本端点后，`/search` 由智谱联网搜索、
 * `/fetch` 由智谱网页阅读（webReader）承接。wire 协议对齐
 * `@deepseek-ai/dsh-web-deepseek-api`：请求
 * `{ query, count, need_content, ori_question? }` / `{ url }`，响应
 * `{ results: [{ url, title, snippet, date }] }` / `{ content }`。
 * 鉴权是 `Authorization: Bearer <智谱凭据>`——web_search 复用智谱模型的
 * 那把 Key（apiKeyEnv 指向它），端点每次请求现解析同一凭据做 timing-safe
 * 比对：没有独立令牌可配，密钥轮换自动跟随，URL 本身不携带秘密。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { writeTextAtomic } from '@dsh-plugins/shared/patch'
import { WebError, type WebSearchResult } from '@deepseek-ai/dsh-web'
import type { ZhipuReader } from './reader'
import type { ZhipuSearch } from './search'

/** 端点默认监听端口；被占用时回退系统分配并回写状态文件。 */
export const DEFAULT_ENDPOINT_PORT = 39617
/** 内置 Search API 的 count 上下界（对齐官方校验）。 */
const MAX_COUNT = 50

/** 端点回写 `$DSH_HOME` 的状态文件形状。 */
export interface EndpointState {
  port: number
}

/** 路由依赖：期望的 Bearer 凭据（现解析的智谱 Key）与搜索 / 阅读核心（测试可注入）。 */
export interface EndpointRouterDeps {
  resolveExpectedKey: () => Promise<string>
  search: ZhipuSearch
  read: ZhipuReader
}

const LOOPBACK_HOST = '127.0.0.1'

function sameToken(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'))
}

/** 取 Bearer 凭据；内置提供方在 API-key 路径下发的正是这个头。 */
function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization
  if (typeof authorization !== 'string') return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim())
  return match?.[1]
}

/** 调用方提前断开时中止上游请求。注意挂 res 而非 req：req 的 'close' 在
 * 请求体读完后即触发，会误中止仍在进行的上游调用。 */
function abortWithCaller(res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) controller.abort()
  })
  return controller.signal
}

/** 逐字段映射成官方解析器要求的形状：`date` 必须在场（null 或字符串）。 */
function toApiResults(
  result: WebSearchResult,
  count: number,
): { results: { url: string; title: string; snippet: string; date: string | null }[] } {
  return {
    results: result.sources.slice(0, count).map((source) => ({
      url: source.url,
      title: source.title ?? '',
      snippet: source.snippet ?? '',
      date: source.publishedAt ?? null,
    })),
  }
}

async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EndpointRouterDeps,
  signal: AbortSignal,
): Promise<void> {
  const body = await readJsonBody(req)
  if (typeof body.query !== 'string' || body.query.length === 0 || body.query !== body.query.trim()) {
    throw new HttpError(400, 'query 必须是非空字符串')
  }
  let count = MAX_COUNT
  if (body.count !== undefined) {
    if (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 1) {
      throw new HttpError(400, 'count 必须是正整数')
    }
    count = Math.min(body.count, MAX_COUNT)
  }
  // need_content / ori_question 是官方 Messages 侧概念，智谱无对应入参，忽略。
  const result = await deps.search(body.query, signal)
  writeJson(res, 200, toApiResults(result, count))
}

async function handleFetch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EndpointRouterDeps,
  signal: AbortSignal,
): Promise<void> {
  const body = await readJsonBody(req)
  if (typeof body.url !== 'string' || body.url.length === 0) throw new HttpError(400, 'url 必须是非空字符串')
  // 官方 Fetch 契约只有 content；reader 多出的 title / metadata 等在此丢弃。
  const content = await deps.read(body.url, signal)
  writeJson(res, 200, { content })
}

/**
 * 端点请求路由（与监听生命周期解耦，供假 req/res 直接集成测试）。
 * 信任边界：仅 loopback Host + 非跨站请求 + 路径 token 三者齐全才可达。
 */
export function createEndpointRouter(
  deps: EndpointRouterDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (!isExpectedHost(req, LOOPBACK_HOST) || !isTrustedFetch(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: '仅接受 POST' })
        return
      }
      let pathname: string
      try {
        pathname = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`).pathname
      } catch {
        writeJson(res, 404, { error: 'not found' })
        return
      }
      const match = /^\/(search|fetch)$/.exec(pathname)
      if (match === null) {
        writeJson(res, 404, { error: 'not found' })
        return
      }
      const presented = bearerToken(req)
      // 凭据每次现解析：Key 轮换即时生效；解析失败与 Bearer 缺失/错误同形 401，
      // 不向探测方区分「没配 Key」和「Key 不对」。
      let authorized = false
      if (presented !== undefined) {
        try {
          authorized = sameToken(presented, await deps.resolveExpectedKey())
        } catch {
          authorized = false
        }
      }
      if (!authorized) {
        writeJson(res, 401, { error: 'unauthorized' })
        return
      }
      const signal = abortWithCaller(res)
      if (match[1] === 'search') await handleSearch(req, res, deps, signal)
      else await handleFetch(req, res, deps, signal)
    } catch (error: unknown) {
      if (res.writableEnded || res.headersSent) {
        // 响应已开始后出错：只能断开，不能再改写状态码。
        res.destroy()
        return
      }
      if (error instanceof HttpError) {
        writeJson(res, error.status, { error: error.message })
        return
      }
      const message = error instanceof WebError ? error.message : `端点内部错误：${errMsg(error)}`
      writeJson(res, 502, { error: message })
    }
  }
}

async function loadEndpointState(file: string): Promise<EndpointState | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`端点状态文件 ${file} 不是有效 JSON（${errMsg(error)}）；请删除该文件后重启宿主`, {
      cause: error,
    })
  }
  const state = parsed as { port?: unknown }
  if (
    typeof state.port !== 'number' ||
    !Number.isInteger(state.port) ||
    state.port < 1 ||
    state.port > 65535
  ) {
    throw new Error(`端点状态文件 ${file} 内容不符合预期；请删除该文件后重启宿主`)
  }
  // 旧版文件还带 token 字段（已废弃的独立访问令牌）：读时忽略，写回即消失。
  return { port: state.port }
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onListening = (): void => {
      cleanup()
      resolve((server.address() as AddressInfo).port)
    }
    const cleanup = (): void => {
      server.off('error', onError)
      server.off('listening', onListening)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, LOOPBACK_HOST)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

/** 启动端点监听：状态文件缺省时用默认端口；端口被占时回退系统分配并回写。 */
export async function startEndpointServer(options: {
  stateFile: string
  resolveExpectedKey: () => Promise<string>
  search: ZhipuSearch
  read: ZhipuReader
}): Promise<{ port: number; baseUrl: string; close: () => Promise<void> }> {
  const loaded = await loadEndpointState(options.stateFile)
  const state: EndpointState = loaded ?? { port: DEFAULT_ENDPOINT_PORT }
  const router = createEndpointRouter({
    resolveExpectedKey: options.resolveExpectedKey,
    search: options.search,
    read: options.read,
  })
  const server: Server = createServer((req, res) => {
    void router(req, res)
  })
  let port: number
  try {
    port = await listenOn(server, state.port)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      await closeServer(server)
      throw error
    }
    port = await listenOn(server, 0)
  }
  if (loaded === null || loaded.port !== port) {
    await writeTextAtomic(options.stateFile, `${JSON.stringify({ port }, null, 2)}\n`)
  }
  return {
    port,
    baseUrl: `http://${LOOPBACK_HOST}:${port}`,
    close: () => closeServer(server),
  }
}
