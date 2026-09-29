import spawn from 'cross-spawn'
import { errMsg } from '@dsh-plugins/shared'
import type { CheckResponse, McpConfigDraft } from './shared'

/** 握手探测默认超时：stdio 首次拉起可能含 npx 下载，留足余量。 */
export const PROBE_TIMEOUT_MS = 20_000

// MCP 握手第一步：能应答 initialize 即证明服务器在线且讲 JSON-RPC。官方
// Loader 的首步探测无超时，坏服务器会永远停在「连接中」，这里在写盘前把
// 同样的问题提前暴露。
const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'dsh-mcp', version: '0.0.0' },
  },
}

/** 单行文本 → 本请求的 JSON-RPC 应答（剥 SSE data: 前缀；请求 / 通知 / 非 JSON 行返回 undefined）。 */
function rpcResponseOf(line: string): { error?: unknown } | undefined {
  const payload = line
    .trim()
    .replace(/^data:/, '')
    .trim()
  if (payload.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (record.method !== undefined || record.id !== 1) return undefined
  return record as { error?: unknown }
}

function outcomeOf(response: { error?: unknown }): CheckResponse {
  return response.error === undefined
    ? { ok: true }
    : { ok: false, error: `服务器拒绝了 initialize：${JSON.stringify(response.error)}` }
}

function probeStdio(config: McpConfigDraft, timeoutMs: number): Promise<CheckResponse> {
  const endpoint = [config.command, ...(config.args ?? [])].join(' ')
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(config.command ?? '', config.args ?? [], {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        // 与官方 StdioClientTransport 同款 cross-spawn、无 shell：args 直传
        // 不经插值，Windows 上 npx 等 .cmd 的解析与转义由 cross-spawn 承担。
        // posix 上独立进程组，收尾整组击杀兜住 npx 拉起的孙进程。
        detached: process.platform !== 'win32',
        windowsHide: process.platform === 'win32',
      })
    } catch (error) {
      resolve({ ok: false, error: `无法启动 ${endpoint}：${errMsg(error)}` })
      return
    }
    let pending = ''
    let stderr = ''
    let settled = false
    const finish = (outcome: CheckResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.pid !== undefined && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill()
        }
      } else {
        child.kill()
      }
      resolve(outcome)
    }
    const fail = (detail: string): void => {
      const tail = stderr.trim().slice(-800)
      finish({ ok: false, error: tail.length > 0 ? `${detail}：${tail}` : detail })
    }
    const timer = setTimeout(() => fail(`握手超时：${timeoutMs}ms 内没有收到 initialize 应答`), timeoutMs)
    child.on('error', (error) => finish({ ok: false, error: `无法启动 ${endpoint}：${errMsg(error)}` }))
    child.on('exit', (code, signal) =>
      fail(`进程提前退出（${code !== null ? `exit ${code}` : `信号 ${signal}`}）`),
    )
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 8192) stderr = stderr.slice(-4096)
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      pending += chunk
      for (;;) {
        const index = pending.indexOf('\n')
        if (index < 0) return
        const response = rpcResponseOf(pending.slice(0, index))
        pending = pending.slice(index + 1)
        if (response !== undefined) {
          finish(outcomeOf(response))
          return
        }
      }
    })
    // 服务器提前退出时 stdin 写入的 EPIPE 不是探测结论本身。
    child.stdin?.on('error', () => {})
    child.stdin?.write(JSON.stringify(INITIALIZE_BODY) + '\n')
  })
}

/** 读 SSE 流直到出现应答或流结束；收到即 cancel，不陪服务器挂长连接。 */
async function sseBodyText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    const lines = text.split('\n')
    if (lines.slice(0, -1).some((line) => rpcResponseOf(line) !== undefined)) break
    if (text.length > 65536) text = text.slice(-32768)
  }
  await reader.cancel().catch(() => {})
  return text
}

function transportErrorOf(error: unknown, config: McpConfigDraft, timeoutMs: number): CheckResponse {
  // AbortSignal.timeout 的 reason 是 DOMException（名字而非 instanceof 判定）。
  const name = (error as { name?: string } | null | undefined)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { ok: false, error: `握手超时：${timeoutMs}ms 内没有收到 initialize 应答` }
  }
  return { ok: false, error: `无法连接 ${config.url ?? ''}：${errMsg(error)}` }
}

async function probeHttp(config: McpConfigDraft, timeoutMs: number): Promise<CheckResponse> {
  let response: Response
  try {
    response = await fetch(config.url ?? '', {
      method: 'POST',
      headers: {
        ...config.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(INITIALIZE_BODY),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return transportErrorOf(error, config, timeoutMs)
  }
  if (!response.ok) return { ok: false, error: `HTTP ${response.status} ${response.statusText}` }
  const contentType = response.headers.get('content-type') ?? ''
  let text: string
  try {
    text = contentType.includes('text/event-stream')
      ? await sseBodyText(response.body)
      : await response.text()
  } catch (error) {
    return transportErrorOf(error, config, timeoutMs)
  }
  for (const line of text.split('\n')) {
    const rpcResponse = rpcResponseOf(line)
    if (rpcResponse !== undefined) return outcomeOf(rpcResponse)
  }
  return {
    ok: false,
    error: `端点应答了（${contentType || '未知类型'}），但不是 initialize 的 JSON-RPC 应答`,
  }
}

/** 保存前的连接检查：按传输形态拉起 / 直连并等一个 initialize 应答。 */
export async function probeConfig(
  config: McpConfigDraft,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<CheckResponse> {
  return config.transport === 'stdio' ? probeStdio(config, timeoutMs) : probeHttp(config, timeoutMs)
}
