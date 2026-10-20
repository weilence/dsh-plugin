import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  ID_PATTERN,
  SSH_ALIAS_PATTERN,
  type ConnectionTarget,
  type RemoteConnection,
  type SaveRequest,
} from './shared'

/** 存储文件名（相对 DSH_HOME）。 */
export const STORE_NAME = 'dsh-remote.json'

/** 一个连接的同步 manifest。 */
export interface SyncManifest {
  /** skills 根键 → 已推送的技能名。 */
  skills: Record<string, string[]>
  /** 已下发到远端 patch 的 MCP 行 id。 */
  mcp: string[]
  /** 已在远端安装的插件包名。 */
  plugins: string[]
  /** 最近一次提示词同步是否推送了 system-prompt.md。 */
  prompts: boolean
}

/**
 * 持久化的连接（host 内部形态）：`secret` 只有在 rememberSecret 时才可能非空
 * ——「记住密码」关闭时口令只驻宿主内存（引擎的会话口令表），这里恒为 null。
 */
export interface StoredConnection {
  id: string
  label: string
  target: ConnectionTarget
  secret: string | null
  rememberSecret: boolean
  createdAt: string
  updatedAt: string
}

export interface StoreFile {
  version: 2
  connections: StoredConnection[]
  manifest: Record<string, SyncManifest>
}

// 注意：不得导出可变默认对象供展开复用——浅拷贝会共享 connections 数组
// 引用，一次 push 污染所有「空库」读取方（回空路径必须字面量新建）。

/** 读取连接库；缺失 / 损坏 / 形状不对回空库。v1 的 sshAlias 记录就地迁移为别名目标。 */
export async function readStore(homeDir: string): Promise<StoreFile> {
  let raw: string
  try {
    raw = await readFile(join(homeDir, STORE_NAME), 'utf8')
  } catch {
    return { version: 2, connections: [], manifest: {} }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { version: 2, connections: [], manifest: {} }
    const record = parsed as { connections?: unknown; manifest?: unknown }
    const connections = Array.isArray(record.connections)
      ? record.connections.flatMap((item) => {
          const connection = normalizeStored(item)
          return connection === null ? [] : [connection]
        })
      : []
    const manifest: Record<string, SyncManifest> = {}
    if (typeof record.manifest === 'object' && record.manifest !== null) {
      for (const [id, value] of Object.entries(record.manifest as Record<string, unknown>)) {
        if (isManifest(value)) manifest[id] = { ...value, prompts: value.prompts === true }
      }
    }
    return { version: 2, connections, manifest }
  } catch {
    return { version: 2, connections: [], manifest: {} }
  }
}

/** 原子覆写连接库（同目录临时文件 + rename，0600）。 */
export async function writeStore(homeDir: string, store: StoreFile): Promise<void> {
  const target = join(homeDir, STORE_NAME)
  await mkdir(homeDir, { recursive: true })
  const temporary = join(
    dirname(target),
    `.${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  )
  // 口令可能落在文件里：临时文件与最终文件都只对当前用户可读（Windows 上
  // mode 被忽略，由用户目录的 ACL 兜底）
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600).catch(() => {})
}

/** 读入一条连接：v2 形态原样归一，v1 的 sshAlias 记录迁移为别名目标。 */
function normalizeStored(value: unknown): StoredConnection | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.label !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null
  }
  let target: ConnectionTarget
  if (isTarget(record.target)) {
    target = record.target
  } else if (typeof record.sshAlias === 'string') {
    // v1：连接只有别名，认证完全在 ~/.ssh/config 侧
    target = { kind: 'alias', alias: record.sshAlias }
  } else {
    return null
  }
  const rememberSecret = record.rememberSecret === true && target.kind === 'direct'
  const secret =
    rememberSecret && typeof record.secret === 'string' && record.secret.length > 0 ? record.secret : null
  return {
    id: record.id,
    label: record.label,
    target,
    secret,
    rememberSecret,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function isTarget(value: unknown): value is ConnectionTarget {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.kind === 'alias') return typeof record.alias === 'string'
  if (record.kind !== 'direct') return false
  return (
    typeof record.host === 'string' &&
    (record.port === null || typeof record.port === 'number') &&
    (record.user === null || typeof record.user === 'string') &&
    (record.auth === 'key' || record.auth === 'password') &&
    (record.identityFile === null || typeof record.identityFile === 'string')
  )
}

function isManifest(value: unknown): value is SyncManifest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.skills !== 'object' || record.skills === null) return false
  for (const names of Object.values(record.skills as Record<string, unknown>)) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) return false
  }
  return (
    Array.isArray(record.mcp) &&
    record.mcp.every((id) => typeof id === 'string') &&
    Array.isArray(record.plugins) &&
    record.plugins.every((name) => typeof name === 'string') &&
    // 提示词同步加入前的旧库无此字段：读入按 false 归一（manifest 只是记录）
    (record.prompts === undefined || typeof record.prompts === 'boolean')
  )
}

/** 校验错误（路由转 400）。 */
export class ValidationError extends Error {}

/** 主机名字符集：IP / IPv6 / 域名，拒绝空白、@ 与 shell 元字符。 */
const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/
/** 远端用户名（OpenSSH 的 user 部分，不含 @）。 */
const USER_PATTERN = /^[A-Za-z0-9._-]+$/
/** 地址末尾误带端口（单冒号 + 数字）；IPv6 有多个冒号，不在此列。 */
const HOST_PORT_SUFFIX = /^[^:]+:\d+$/
const SECRET_MAX = 1024

/** 展开 ~ 前缀（本机路径；ssh 子进程不经 shell，~ 不会被替我们展开）。 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (/^~[\\/]/.test(path)) return join(homedir(), path.slice(2))
  return path
}

/** 校验并归一一个连接目标（保存与表单测试共用；私钥文件必须已存在）。 */
export async function normalizeTarget(target: ConnectionTarget): Promise<ConnectionTarget> {
  if (typeof target !== 'object' || target === null) {
    throw new ValidationError('缺少连接目标')
  }
  if (target.kind === 'alias') {
    const alias = target.alias.trim()
    if (!SSH_ALIAS_PATTERN.test(alias)) {
      throw new ValidationError('SSH 别名必须是 ~/.ssh/config 里的主机别名（字母数字开头，可含 . _ -）')
    }
    return { kind: 'alias', alias }
  }
  const host = target.host.trim()
  if (host.length === 0) throw new ValidationError('地址不能为空')
  if (host.length > 255) throw new ValidationError('地址过长（上限 255 字符）')
  if (!HOST_PATTERN.test(host)) {
    throw new ValidationError('地址含非法字符（只允许字母、数字、. _ - 与 IPv6 的冒号）')
  }
  if (host.startsWith('-')) throw new ValidationError('地址不能以 - 开头')
  if (HOST_PORT_SUFFIX.test(host)) {
    throw new ValidationError('端口请填在端口字段（地址里不要带 :端口）')
  }
  if (target.port !== null && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) {
    throw new ValidationError('端口必须是 1–65535 的整数')
  }
  const user = target.user === null ? null : target.user.trim()
  if (user !== null && (!USER_PATTERN.test(user) || user.startsWith('-'))) {
    throw new ValidationError('用户名只能包含字母、数字、. _ -，且不能以 - 开头')
  }
  if (target.auth === 'password') {
    return { kind: 'direct', host, port: target.port, user, auth: 'password', identityFile: null }
  }
  if (target.auth !== 'key') throw new ValidationError('认证方式必须是密钥文件或密码')
  const raw = target.identityFile?.trim() ?? ''
  if (raw.length === 0) throw new ValidationError('密钥文件不能为空')
  const identityFile = expandHomePath(raw)
  if (!isAbsolute(identityFile)) {
    throw new ValidationError('密钥文件请用绝对路径，或以 ~/ 开头')
  }
  let info
  try {
    info = await stat(identityFile)
  } catch {
    throw new ValidationError(`密钥文件不存在或不可读：${identityFile}`)
  }
  if (!info.isFile()) throw new ValidationError(`密钥文件不是普通文件：${identityFile}`)
  return { kind: 'direct', host, port: target.port, user, auth: 'key', identityFile }
}

/** 口令输入归一：undefined = 不修改；'' = 清除；其余原样（不 trim）。 */
export function normalizeSecret(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ValidationError('口令必须是字符串')
  if (value === '') return null
  if (value.length > SECRET_MAX) throw new ValidationError(`口令过长（上限 ${SECRET_MAX} 字符）`)
  if (/[\r\n]/.test(value)) throw new ValidationError('口令不能包含换行')
  return value
}

export interface NormalizedConnection {
  /** 落盘形态：rememberSecret=false 时 secret 恒为 null。 */
  connection: StoredConnection
  /** 本次保存后的可用口令（rememberSecret=false 时进宿主内存）。 */
  secret: string | null
}

/**
 * 校验并归一一个保存请求（连接只有基本信息——同步勾选随 POST /sync 直传，
 * 不在连接上持久化）。id 缺省时从别名 / 地址派生（冲突时加随机后缀）。
 * `previousSecret` 是编辑前该连接**实际可用**的口令（可能只在内存里），
 * 用作「表单留空 = 保持」的来源。
 */
export async function normalizeConnection(
  request: SaveRequest,
  existingIds: ReadonlySet<string>,
  now: string,
  previous?: StoredConnection,
  previousSecret: string | null = previous?.secret ?? null,
): Promise<NormalizedConnection> {
  if (typeof request !== 'object' || request === null) throw new ValidationError('缺少保存请求')
  const label = typeof request.label === 'string' ? request.label.trim() : ''
  if (label.length === 0) throw new ValidationError('label 不能为空')
  const target = await normalizeTarget(request.target)
  const submitted = normalizeSecret(request.secret)
  let secret: string | null
  if (submitted !== undefined) {
    secret = submitted
  } else {
    secret = previousSecret
    // 认证方式换了却没重填口令：不沿用旧口令（私钥口令与登录密码不是一回事）
    if (
      previous !== undefined &&
      previous.target.kind === 'direct' &&
      target.kind === 'direct' &&
      previous.target.auth !== target.auth
    ) {
      secret = null
    }
  }
  if (target.kind === 'alias') secret = null
  // 密码登录允许没有口令（典型：清除已保存的口令，下次连接时由面板现场补录）；
  // 引擎在真正发起操作前用 SecretRequiredError 要求补录，不把一次注定失败的
  // 认证算成连接失败。
  const rememberSecret = target.kind === 'direct' && request.rememberSecret === true
  let id = previous?.id
  if (id === undefined) {
    const source = target.kind === 'alias' ? target.alias : target.host
    const base =
      source
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'remote'
    id = ID_PATTERN.test(base) ? base : 'remote'
    while (existingIds.has(id)) id = `${id}-${randomBytes(2).toString('hex')}`
  }
  return {
    connection: {
      id,
      label,
      target,
      secret: rememberSecret ? secret : null,
      rememberSecret,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    },
    secret,
  }
}

/** 落盘形态 → 面板形态（口令只留状态，值不出 host）。 */
export function toRemoteConnection(
  connection: StoredConnection,
  sessionHasSecret: boolean,
): RemoteConnection {
  return {
    id: connection.id,
    label: connection.label,
    target: connection.target,
    rememberSecret: connection.rememberSecret,
    secretState: connection.secret !== null ? 'saved' : sessionHasSecret ? 'session' : 'none',
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  }
}
