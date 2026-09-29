/**
 * 连接库与同步 manifest 的持久化（host 专用）：`$DSH_HOME/dsh-remote.json`
 * 一个文件，损坏 / 缺失一律回空库（面板从空开始，不阻塞加载）。
 *
 * manifest 只是最近一次同步的记录展示（哪些名字上次同步过）；删除判定
 * 以「本机清单 ∩ 远端清单」实时计算，远端手装内容零接触。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ID_PATTERN, SSH_ALIAS_PATTERN, type RemoteConnection, type SaveRequest } from './shared'

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
}

export interface StoreFile {
  version: 1
  connections: RemoteConnection[]
  manifest: Record<string, SyncManifest>
}

// 注意：不得导出可变默认对象供展开复用——浅拷贝会共享 connections 数组
// 引用，一次 push 污染所有“空库”读取方（回空路径必须字面量新建）。

/** 读取连接库；缺失 / 损坏 / 形状不对回空库。 */
export async function readStore(homeDir: string): Promise<StoreFile> {
  let raw: string
  try {
    raw = await readFile(join(homeDir, STORE_NAME), 'utf8')
  } catch {
    return { version: 1, connections: [], manifest: {} }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, connections: [], manifest: {} }
    const record = parsed as { connections?: unknown; manifest?: unknown }
    const connections = Array.isArray(record.connections)
      ? record.connections
          .filter((item): item is RemoteConnection => isConnection(item))
          // 读入即归一到已知字段：旧库残字段（如已删除的 sync 勾选）剥离，
          // 下次写盘落净形态
          .map((item) => ({
            id: item.id,
            label: item.label,
            sshAlias: item.sshAlias,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          }))
      : []
    const manifest: Record<string, SyncManifest> = {}
    if (typeof record.manifest === 'object' && record.manifest !== null) {
      for (const [id, value] of Object.entries(record.manifest as Record<string, unknown>)) {
        if (isManifest(value)) manifest[id] = value
      }
    }
    return { version: 1, connections, manifest }
  } catch {
    return { version: 1, connections: [], manifest: {} }
  }
}

/** 原子覆写连接库（同目录临时文件 + rename）。 */
export async function writeStore(homeDir: string, store: StoreFile): Promise<void> {
  const target = join(homeDir, STORE_NAME)
  await mkdir(homeDir, { recursive: true })
  const temporary = join(
    dirname(target),
    `.${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  )
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}

function isConnection(value: unknown): value is RemoteConnection {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.label === 'string' &&
    typeof record.sshAlias === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
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
    record.plugins.every((name) => typeof name === 'string')
  )
}

/** 校验错误（路由转 400）。 */
export class ValidationError extends Error {}

/** 校验并归一一个保存请求（连接只有基本信息——同步勾选随 POST /sync 直传，
 *  不在连接上持久化）；id 缺省时从 sshAlias 派生（冲突时加随机后缀）。 */
export function normalizeConnection(
  request: SaveRequest,
  existingIds: ReadonlySet<string>,
  now: string,
  previous?: RemoteConnection,
): RemoteConnection {
  const label = request.label.trim()
  if (label.length === 0) throw new ValidationError('label 不能为空')
  const sshAlias = request.sshAlias.trim()
  if (!SSH_ALIAS_PATTERN.test(sshAlias)) {
    throw new ValidationError('sshAlias 必须是 ~/.ssh/config 里的主机别名（字母数字开头，可含 . _ -）')
  }
  let id = previous?.id
  if (id === undefined) {
    const base =
      sshAlias
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'remote'
    id = ID_PATTERN.test(base) ? base : 'remote'
    while (existingIds.has(id)) id = `${id}-${randomBytes(2).toString('hex')}`
  }
  return {
    id,
    label,
    sshAlias,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}
