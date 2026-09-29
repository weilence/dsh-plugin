import type { IncomingMessage, ServerResponse } from 'node:http'

/** 携带 HTTP 状态的业务错误。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const MAX_BODY_BYTES = 2 * 1024 * 1024

// URL.hostname 保留 IPv6 字面量的方括号；127/8 整段都是 loopback，但
// 八位组须 ≤255（Host 头未经 URL 解析时可能携带 127.256.0.1 之类的畸形值）。
const LOOPBACK_IPV4 = /^127(?:\.(?:\d{1,2}|1\d{2}|2[0-4]\d|25[0-5])){3}$/

export function isLoopbackHostname(hostname: string) {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return bare === 'localhost' || bare === '::1' || bare === '0:0:0:0:0:0:0:1' || LOOPBACK_IPV4.test(bare)
}

// loopback 绑定接受 localhost / 127.x / ::1 多种拼写；非 loopback 的 Host
// 头一律拒绝——这是本同源接口不服务 DNS-rebinding 页面的依据。
export function isExpectedHost(req: IncomingMessage, expectedHost: string) {
  const authority = req.headers.host
  if (!authority || /[\/@?#]/.test(authority)) return false
  try {
    const actual = new URL(`http://${authority}`).hostname
    if (actual === expectedHost) return true
    return isLoopbackHostname(expectedHost) && isLoopbackHostname(actual)
  } catch {
    return false
  }
}

// 跨站请求（含预检外的简单 POST）不带可用的 sec-fetch-site 同源标记；
// dsh-app: 自定义协议页面该头缺失，与 same-origin 同等放行。
export function isTrustedFetch(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}

export function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) throw new HttpError(400, '缺少 JSON 请求体')
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, '请求体必须是 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, '无效的 JSON 请求体')
  }
}
