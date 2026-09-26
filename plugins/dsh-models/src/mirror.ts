import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const NORMAL_CHECK_MS = 6 * 60 * 60 * 1000
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const
export const MAX_CATALOG_BYTES = 16 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 30_000

export function errMsg(error: unknown) {
  const message = (error as { message?: string } | null | undefined)?.message
  return message || String(error)
}

interface PersistedMeta {
  sha256?: string
  etag?: string
  checkedAt?: number
  updatedAt?: number
}

export interface CatalogSnapshot {
  body: Buffer | null
  etag: string | null
  checkedAt: number | null
  updatedAt: number | null
  lastError: string | null
}

export interface CatalogMirrorOptions {
  cacheDir: string
  fetch?: typeof globalThis.fetch
  now?: () => number
  random?: () => number
  checkIntervalMs?: number
  retryDelaysMs?: readonly number[]
  requestTimeoutMs?: number
  maxBytes?: number
  url?: string
  onInfo?: (message: string) => void
  onWarn?: (message: string) => void
}

function validTime(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function bodyDigest(body: Buffer) {
  return createHash('sha256').update(body).digest('base64url')
}

function normalizeEtag(value: string | null, body: Buffer) {
  const etag = value?.trim()
  if (etag) return etag
  return `"sha256-${bodyDigest(body)}"`
}

function isJsonContentType(value: string | null) {
  return value === null || /(?:^|\/)json(?:;|$)/i.test(value)
}

async function writeAtomic(path: string, body: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(temp, body)
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

export class CatalogMirror {
  private readonly cacheDir: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number
  private readonly random: () => number
  private readonly checkIntervalMs: number
  private readonly retryDelaysMs: readonly number[]
  private readonly requestTimeoutMs: number
  private readonly maxBytes: number
  private readonly url: string
  private readonly onInfo: (message: string) => void
  private readonly onWarn: (message: string) => void
  private state: CatalogSnapshot = {
    body: null,
    etag: null,
    checkedAt: null,
    updatedAt: null,
    lastError: null,
  }
  private inflight: Promise<'updated' | 'unchanged'> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private stopped = false
  private started = false

  constructor(options: CatalogMirrorOptions) {
    this.cacheDir = options.cacheDir
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.checkIntervalMs = options.checkIntervalMs ?? NORMAL_CHECK_MS
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.maxBytes = options.maxBytes ?? MAX_CATALOG_BYTES
    this.url = options.url ?? MODELS_DEV_URL
    this.onInfo = options.onInfo ?? (() => {})
    this.onWarn = options.onWarn ?? (() => {})
  }

  private get bodyPath() {
    return join(this.cacheDir, 'api.json')
  }

  private get metaPath() {
    return join(this.cacheDir, 'meta.json')
  }

  snapshot(): CatalogSnapshot {
    return { ...this.state }
  }

  async loadPersisted() {
    try {
      const [body, metaText] = await Promise.all([readFile(this.bodyPath), readFile(this.metaPath, 'utf8')])
      if (body.byteLength === 0 || body.byteLength > this.maxBytes) {
        throw new Error(`缓存目录体积非法：${body.byteLength} bytes`)
      }
      // 只做完整性校验，不解释模型 schema。
      JSON.parse(body.toString('utf8'))
      const meta = JSON.parse(metaText) as PersistedMeta
      if (typeof meta.sha256 === 'string' && meta.sha256 !== bodyDigest(body)) {
        throw new Error('缓存目录摘要校验失败')
      }
      this.state = {
        body,
        etag: normalizeEtag(typeof meta.etag === 'string' ? meta.etag : null, body),
        checkedAt: validTime(meta.checkedAt),
        updatedAt: validTime(meta.updatedAt),
        lastError: null,
      }
      this.onInfo(`已装载持久化 models.dev 快照（${body.byteLength} bytes）`)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'ENOENT') this.onWarn(`忽略不可用的持久化快照：${errMsg(error)}`)
      return false
    }
  }

  private async persist(body: Buffer, meta: PersistedMeta) {
    await mkdir(this.cacheDir, { recursive: true })
    await writeAtomic(this.bodyPath, body)
    await writeAtomic(this.metaPath, JSON.stringify(meta, null, 2) + '\n')
  }

  private async persistMeta(meta: PersistedMeta) {
    await writeAtomic(this.metaPath, JSON.stringify(meta, null, 2) + '\n')
  }

  async check(): Promise<'updated' | 'unchanged'> {
    if (this.inflight) return this.inflight
    this.inflight = this.performCheck()
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }

  private async performCheck(): Promise<'updated' | 'unchanged'> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.state.etag) headers['If-None-Match'] = this.state.etag
    const response = await this.fetchImpl(this.url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    const checkedAt = this.now()
    if (response.status === 304) {
      const currentBody = this.state.body
      if (!currentBody) throw new Error('上游返回 304，但本地没有可复用的目录快照')
      this.state = { ...this.state, checkedAt, lastError: null }
      await this.persistMeta({
        sha256: bodyDigest(currentBody),
        etag: this.state.etag ?? undefined,
        checkedAt,
        updatedAt: this.state.updatedAt ?? undefined,
      }).catch((error) => this.onWarn(`目录检查状态持久化失败：${errMsg(error)}`))
      return 'unchanged'
    }
    if (!response.ok) throw new Error(`models.dev 返回 HTTP ${response.status}`)
    if (!isJsonContentType(response.headers.get('content-type'))) {
      throw new Error(`models.dev 返回了非 JSON Content-Type：${response.headers.get('content-type')}`)
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new Error(`models.dev 响应超过体积上限：${declared} bytes`)
    }
    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength === 0 || body.byteLength > this.maxBytes) {
      throw new Error(`models.dev 响应体积非法：${body.byteLength} bytes`)
    }
    JSON.parse(body.toString('utf8'))
    const etag = normalizeEtag(response.headers.get('etag'), body)
    const updatedAt = checkedAt
    await this.persist(body, { sha256: bodyDigest(body), etag, checkedAt, updatedAt }).catch((error) => {
      this.onWarn(`新目录已进入内存，但持久化失败：${errMsg(error)}`)
    })
    this.state = { body, etag, checkedAt, updatedAt, lastError: null }
    this.onInfo(`models.dev 目录已更新（${body.byteLength} bytes，ETag ${etag}）`)
    return 'updated'
  }

  private nextDelay(success: boolean) {
    if (success) return this.checkIntervalMs
    const index = Math.min(Math.max(0, this.failures - 1), this.retryDelaysMs.length - 1)
    return this.retryDelaysMs[index] ?? this.checkIntervalMs
  }

  private schedule(delay: number) {
    if (this.stopped) return
    // ±5% 抖动避免整群同步检查。
    const jittered = Math.max(1, Math.round(delay * (0.95 + this.random() * 0.1)))
    this.timer = setTimeout(() => {
      void this.tick()
    }, jittered)
  }

  private async tick() {
    if (this.stopped) return
    let success = false
    try {
      await this.check()
      this.failures = 0
      success = true
    } catch (error) {
      this.failures += 1
      const message = errMsg(error)
      this.state = { ...this.state, lastError: message }
      this.onWarn(`models.dev 目录检查失败，将继续使用最后成功快照：${message}`)
    }
    this.schedule(this.nextDelay(success))
  }

  start() {
    if (this.started) return
    this.started = true
    this.stopped = false
    void this.tick()
  }

  stop() {
    this.started = false
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
