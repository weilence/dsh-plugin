import { createHash } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  RemoteTransport,
  RemoteTransportConnection,
  RemoteTransportPath,
} from '@dsh-plugins/shared/remote'
import { errMsg } from '@dsh-plugins/shared'
import type { RemoteEngine } from './engine'
import type { ConnRow, ConnRunning } from './shared'

const TIMEOUT_MS = 120_000
const MAX_REQUEST_BYTES = 96 * 1024 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

function tunnelUrl(running: ConnRunning): URL {
  let url: URL
  try {
    url = new URL(running.url)
  } catch {
    throw new Error('连接的隧道 URL 无效')
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
    url.username ||
    url.password ||
    Number(url.port || 80) !== running.localPort ||
    !Number.isInteger(running.localPort) ||
    running.localPort < 1 ||
    running.localPort > 65535 ||
    url.pathname !== '/' ||
    url.hash ||
    url.searchParams.getAll('token').length !== 1 ||
    !url.searchParams.get('token') ||
    [...url.searchParams.keys()].some((key) => key !== 'token')
  ) {
    throw new Error('连接必须提供与本地转发端口一致、含启动 token 的 loopback HTTP 根 URL')
  }
  return url
}

function connectionInfo(row: ConnRow): RemoteTransportConnection {
  const info: RemoteTransportConnection = { id: row.id, label: row.label, available: false }
  const { phase, op, running, error } = row.state
  let detail = error?.message.replace(/([?&]token=)[^&\s]+/g, '$1[token]')
  const token = running?.url.match(/[?&]token=([^&]+)/)?.[1]
  if (token && detail) detail = detail.replaceAll(token, '[token]')
  if (phase === 'stopping' || op?.kind === 'disconnect') return { ...info, reason: 'stopping' }
  if (phase === 'deploying' || phase === 'starting' || op?.kind === 'connect') {
    return { ...info, reason: 'connecting' }
  }
  if (op !== null) return { ...info, reason: 'busy', detail: op.kind }
  if (running === null) {
    return error === null ? { ...info, reason: 'disconnected' } : { ...info, reason: 'error', detail }
  }
  if (phase !== 'running' && phase !== 'probing') {
    return { ...info, reason: 'error', detail: detail ?? `连接阶段：${phase}` }
  }
  try {
    tunnelUrl(running)
    return { ...info, available: true }
  } catch (error) {
    return { ...info, reason: 'invalid-tunnel', detail: errMsg(error) }
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error(`远端响应超过 ${MAX_RESPONSE_BYTES} 字节限制`)
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader !== undefined) {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) throw new Error(`远端响应超过 ${MAX_RESPONSE_BYTES} 字节限制`)
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error(`远端接口没有返回 JSON（HTTP ${response.status}）`)
  }
  let result: unknown
  try {
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error(`远端接口返回了无效的 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const detail =
      typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string'
        ? `：${result.error}`
        : ''
    throw new Error(`远端接口失败（HTTP ${response.status}）${detail}`)
  }
  return result
}

/** 复用插件唯一的引擎；Cookie 仅驻留在单次请求中，不能跨连接或重连复用。 */
export class RemoteTransportService extends Service implements RemoteTransport {
  private disposed = false

  constructor(
    ctx: Context,
    private readonly engine: RemoteEngine,
  ) {
    super(ctx, 'remoteTransport')
    ctx.effect(() => () => {
      this.disposed = true
    })
  }

  listConnections(): RemoteTransportConnection[] {
    return this.engine.rows().map(connectionInfo)
  }

  async request(id: string, path: RemoteTransportPath, body: unknown): Promise<unknown> {
    if (path !== '/dsh-sessions/preview' && path !== '/dsh-sessions/import') {
      throw new Error('远端传输仅允许会话 preview / import 路径')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('远端请求体必须是 JSON 对象')
    }
    const payload = JSON.stringify(body)
    if (typeof payload !== 'string' || !payload.startsWith('{')) {
      throw new Error('序列化后的远端请求体必须是 JSON 对象')
    }
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
      throw new Error(`远端请求体超过 ${MAX_REQUEST_BYTES} 字节限制`)
    }
    const row = this.engine.rows().find((candidate) => candidate.id === id)
    if (row === undefined) throw new Error('没有找到指定的远端连接')
    const info = connectionInfo(row)
    if (!info.available)
      throw new Error(`远端连接不可用：${info.reason}${info.detail ? `（${info.detail}）` : ''}`)
    const running = { ...row.state.running! }
    const url = tunnelUrl(running)
    const token = url.searchParams.get('token')!
    let sessionCookie = ''
    const redact = (text: string) => {
      const safe = text
        .replaceAll(running.url, '[隧道 URL]')
        .replaceAll(encodeURIComponent(token), '[token]')
        .replaceAll(token, '[token]')
      return sessionCookie ? safe.replaceAll(sessionCookie, '[Cookie]') : safe
    }
    const assertUnchanged = () => {
      const current = this.engine.rows().find((candidate) => candidate.id === id)
      if (
        this.disposed ||
        current === undefined ||
        !connectionInfo(current).available ||
        current.state.running?.url !== running.url ||
        current.state.running.localPort !== running.localPort ||
        current.state.running.remotePort !== running.remotePort ||
        current.state.running.pid !== running.pid ||
        current.state.running.since !== running.since
      ) {
        throw new Error('远端连接在传输期间发生变化；操作可能已经提交，请重新预览确认，不要直接重试导入')
      }
    }
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    let response: Response | undefined
    let postStarted = false
    try {
      assertUnchanged()
      const authentication = await fetch(url, { method: 'GET', redirect: 'manual', signal })
      await authentication.body?.cancel()
      assertUnchanged()
      if (authentication.status !== 303 || authentication.headers.get('location') !== './') {
        throw new Error(`远端启动 token 换取 Cookie 失败（HTTP ${authentication.status}）`)
      }
      // 宿主 browser-auth 的 Cookie 名称绑定完整 authority（含端口），不接受其他 Cookie。
      const name = `dsh-auth-${createHash('sha256').update(url.host).digest('base64url')}`
      const cookies = authentication.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${name}=`))
      if (cookies.length !== 1) throw new Error('远端认证没有返回唯一的 authority 绑定 Cookie')
      const [cookie, ...attributes] = cookies[0].split(';')
      if (
        !cookie ||
        !new RegExp(`^${name}=[A-Za-z0-9_.-]+$`).test(cookie) ||
        attributes.some((attribute) => /^\s*domain\s*=/i.test(attribute)) ||
        !attributes.some((attribute) => /^\s*path=\/$/i.test(attribute))
      ) {
        throw new Error('远端认证 Cookie 的格式或作用域无效')
      }
      sessionCookie = cookie.slice(name.length + 1)
      const endpoint = new URL(path, url.origin)
      assertUnchanged()
      postStarted = true
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-dsh-sessions': '1',
          'sec-fetch-site': 'same-origin',
          origin: url.origin,
          cookie,
        },
        body: payload,
      })
      assertUnchanged()
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new Error(`远端接口返回了不允许跟随的跳转（HTTP ${response.status}）`)
      }
      const result = await readResponse(response)
      assertUnchanged()
      return result
    } catch (error) {
      assertUnchanged()
      const cause = error instanceof Error && error.cause ? `：${errMsg(error.cause)}` : ''
      const uncertain =
        postStarted && path === '/dsh-sessions/import'
          ? '；导入可能已经提交，请重新预览确认，不要直接重试导入'
          : ''
      throw new Error(
        redact(
          signal.aborted
            ? `远端请求超过 ${TIMEOUT_MS}ms 超时限制；操作可能已经提交，请重新预览确认，不要直接重试导入`
            : `${errMsg(error)}${cause}${uncertain}`,
        ),
      )
    } finally {
      await response?.body?.cancel().catch(() => {})
    }
  }
}
