import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { rm, realpath, stat } from 'node:fs/promises'
import { isAbsolute, parse } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  streamSessionLogZip,
} from '@deepseek-ai/dsh-session-log-export'
import { Session, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import {
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
  validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionActivity, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError } from '@dsh-plugins/shared/http'
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_SESSIONS,
  MAX_ENTRY_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_LOG_BYTES,
  MAX_SESSION_EVENTS,
} from './shared.js'
import type { ArchiveExpected, ArchivePreview, ImportResult, MigrateResult } from './shared.js'
import { locateSessionDir } from './storage.js'

interface ArchiveSession {
  header: SessionHeader
  events: SessionEvent[]
  inheritedEventCount: SessionLogOffset
}

interface ArchiveAttachment {
  path: string
  ref: ImageAttachmentRef | FileAttachmentRef
  data: Uint8Array
}

interface ParsedArchive {
  sessions: ArchiveSession[]
  attachments: ArchiveAttachment[]
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const digest = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function contentDigest(session: ArchiveSession): string {
  return digest(stableJson([session.header, session.inheritedEventCount, session.events]))
}

async function targetCwd(cwd: string): Promise<string> {
  if (
    typeof cwd !== 'string' ||
    cwd.trim() === '' ||
    !isAbsolute(cwd) ||
    cwd.includes('\0') ||
    (process.platform === 'win32' && ['\\', '/'].includes(parse(cwd).root))
  ) {
    throw new Error('目标工作目录必须显式填写本机存在的绝对目录')
  }
  const canonical = await realpath(cwd)
  if (!(await stat(canonical)).isDirectory()) throw new Error(`目标工作目录不是目录： ${cwd}`)
  return canonical
}

function assertCold(ctx: Context, id: SessionId): void {
  if (ctx.sessions.get(id) !== undefined) throw new Error(`会话「${id}」已加载，不能作为导入目标`)
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(data: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]!
  return (value ^ 0xffffffff) >>> 0
}

function safePath(path: string): void {
  if (
    path.length > 1024 ||
    /[\\\u0000-\u001f\u007f]/u.test(path) ||
    (path.includes(':') && !/^media\/sha256:[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/u.test(path)) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`ZIP 条目路径不安全： ${JSON.stringify(path)}`)
  }
}

function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('归档超过 64 MiB 上限')
  if (bytes.byteLength < 22) throw new Error('ZIP 归档不完整')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (offset: number): number => view.getUint16(offset, true)
  const u32 = (offset: number): number => view.getUint32(offset, true)
  const signature = (offset: number, expected: number): void => {
    if (offset < 0 || offset + 4 > bytes.length || u32(offset) !== expected) {
      throw new Error(`ZIP 记录无效，字节位置为 ${offset}`)
    }
  }
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557)) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break
    end--
  }
  if (end < Math.max(0, bytes.length - 65557)) throw new Error('ZIP 结束记录缺失')
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== u16(end + 10)) {
    throw new Error('不支持分卷 ZIP 归档')
  }
  const count = u16(end + 10)
  const centralSize = u32(end + 12)
  const centralOffset = u32(end + 16)
  if (count === 65535 || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('不支持 ZIP64 归档')
  }
  if (count === 0 || count > MAX_ARCHIVE_ENTRIES) throw new Error('ZIP 条目数量超过上限')
  if (centralOffset + centralSize !== end) throw new Error('ZIP 中央目录边界无效')
  const entries: Array<{
    path: string
    size: number
    compressed: number
    crc: number
    method: number
    start: number
  }> = []
  const names = new Set<string>()
  let cursor = centralOffset
  let expanded = 0
  const ranges: Array<[number, number]> = []
  for (let index = 0; index < count; index++) {
    signature(cursor, 0x02014b50)
    if (cursor + 46 > end) throw new Error('ZIP 中央目录不完整')
    const flags = u16(cursor + 8)
    const method = u16(cursor + 10)
    const compressed = u32(cursor + 20)
    const size = u32(cursor + 24)
    const nameSize = u16(cursor + 28)
    const extraSize = u16(cursor + 30)
    const commentSize = u16(cursor + 32)
    const local = u32(cursor + 42)
    if (flags & ~0x808 || (method !== 0 && method !== 8)) throw new Error('不支持此 ZIP 加密或压缩方式')
    if (u16(cursor + 34) !== 0 || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      throw new Error('不支持 ZIP64 或分卷条目')
    }
    if (((u32(cursor + 38) >>> 16) & 0xf000) === 0xa000) throw new Error('ZIP 归档不能包含符号链接')
    if (cursor + 46 + nameSize + extraSize + commentSize > end) throw new Error('ZIP 条目元数据不完整')
    const path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameSize))
    safePath(path)
    if (names.has(path)) throw new Error(`ZIP 条目重复： ${path}`)
    names.add(path)
    expanded += size
    if (size > MAX_ENTRY_BYTES || expanded > MAX_EXPANDED_BYTES) throw new Error('ZIP 解压大小超过上限')
    if (/session(?:\.v\d+)?\.jsonl$/u.test(path) && size > MAX_LOG_BYTES)
      throw new Error('会话日志超过 16 MiB 上限')
    signature(local, 0x04034b50)
    if (local + 30 > centralOffset || u16(local + 6) !== flags || u16(local + 8) !== method) {
      throw new Error(`ZIP 本地元数据不一致： ${path}`)
    }
    const localNameSize = u16(local + 26)
    const start = local + 30 + localNameSize + u16(local + 28)
    if (start + compressed > centralOffset || start < local + 30)
      throw new Error(`ZIP 条目边界无效： ${path}`)
    if (decoder.decode(bytes.subarray(local + 30, local + 30 + localNameSize)) !== path) {
      throw new Error(`ZIP 本地文件名不一致： ${path}`)
    }
    const crc = u32(cursor + 16)
    if (
      !(flags & 8) &&
      (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size)
    ) {
      throw new Error(`ZIP 本地长度不一致： ${path}`)
    }
    ranges.push([local, start + compressed])
    entries.push({ path, size, compressed, crc, method, start })
    cursor += 46 + nameSize + extraSize + commentSize
  }
  if (cursor !== end) throw new Error('ZIP 目录大小或条目数量不一致')
  ranges.sort((a, b) => a[0] - b[0])
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index]![0] < ranges[index - 1]![1]) throw new Error('ZIP 条目范围重叠')
  }
  const result = new Map<string, Uint8Array>()
  for (const entry of entries) {
    const compressed = bytes.subarray(entry.start, entry.start + entry.compressed)
    // 先检查目录声明，再用 zlib 硬限制实际输出；伪造长度的压缩炸弹也不能扩展到声明之外。
    const data =
      entry.method === 0
        ? compressed.slice()
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) })
    if (data.length !== entry.size || crc32(data) !== entry.crc)
      throw new Error(`ZIP 长度或 CRC 校验不一致： ${entry.path}`)
    result.set(entry.path, data)
  }
  return result
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function attachmentRefs(events: readonly SessionEvent[]): Array<ImageAttachmentRef | FileAttachmentRef> {
  const refs: Array<ImageAttachmentRef | FileAttachmentRef> = []
  const content = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const valueBlock of value) {
      const block = record(valueBlock)
      if (block.type === 'image' || block.type === 'file') {
        refs.push(block.attachment as ImageAttachmentRef | FileAttachmentRef)
      }
    }
  }
  for (const event of events) {
    const data = record(event.data)
    switch (String(event.type)) {
      case 'user/message':
      case 'tool/ptc-dispatch':
        content(data.content)
        break
      case 'system/message':
      case 'developer/message':
      case 'tool/result':
      case 'team/message/queued':
      case 'assistant/message':
        content(record(data.message).content)
        break
      case 'agent/inbox/spliced':
        if (Array.isArray(data.inserted))
          for (const message of data.inserted) content(record(message).content)
        break
      case 'compaction/summary':
        content(data.summary)
        content(data.rawOutput)
        break
    }
    if (
      (event.type === 'assistant/attempt' || event.type === 'assistant/message') &&
      Array.isArray(data.stream)
    ) {
      for (const item of data.stream) {
        const row = record(item)
        const chunk = record(row.chunk)
        if (row.type === 'chunk' && chunk.type === 'block-end') content([chunk.block])
      }
    }
  }
  return refs
}

function attachmentPath(ref: ImageAttachmentRef | FileAttachmentRef): string {
  if ('mediaType' in ref) return `media/${ref.attachmentId}.${extensions[ref.mediaType]}`
  const hash = String(ref.attachmentId).replace(/^sha256:/u, '')
  const name = ref.name.replace(/[\\/\u0000-\u001f\u007f]/gu, '_')
  return `files/${hash.slice(0, 2)}/${hash}/${name === '' || name === '.' || name === '..' ? 'file' : name}`
}

function attachmentIdentity(ref: ImageAttachmentRef | FileAttachmentRef): string {
  return stableJson(
    'mediaType' in ref
      ? [ref.attachmentId, ref.bytes, ref.mediaType, ref.width, ref.height]
      : [ref.attachmentId, ref.bytes, ref.name],
  )
}

async function parseArchive(ctx: Context, bytes: Uint8Array, cwd: string): Promise<ParsedArchive> {
  const files = readZip(bytes)
  if (!files.has('session.v4.jsonl'))
    throw new Error('归档必须包含官方 session.v4.jsonl 根日志；本版本只支持 V4')
  const sessions: ArchiveSession[] = []
  const ids = new Set<string>()
  const used = new Set<string>()
  const logs = [...files].filter(
    ([path]) => path === 'session.v4.jsonl' || /^subagents\/[A-Za-z0-9_-]+\/session\.v4\.jsonl$/u.test(path),
  )
  logs.sort(([a], [b]) => (a === 'session.v4.jsonl' ? -1 : b === 'session.v4.jsonl' ? 1 : 0))
  for (const [path, data] of logs) {
    if (sessions.length >= MAX_ARCHIVE_SESSIONS) throw new Error('归档会话数量超过上限')
    if (data.length > MAX_LOG_BYTES) throw new Error(`会话日志超过 16 MiB 上限: ${path}`)
    const lines = decoder.decode(data).split('\n')
    if (lines.at(-1) === '') lines.pop()
    if (lines.length - 1 > MAX_SESSION_EVENTS) throw new Error(`会话事件数量超过上限： ${path}`)
    const rawHeader: unknown = JSON.parse(lines[0]!)
    if (record(rawHeader).version !== SESSION_FORMAT_VERSION)
      throw new Error(`本版本只支持当前 V4 日志： ${path}`)
    const restore = sessionFormatCatalog.createRestore(rawHeader, {
      recovery: 'strict',
      validation: 'current',
    })
    for (const line of lines.slice(1)) restore.decodeRow(JSON.parse(line))
    const artifact = restore.finish()
    const header = artifact.header as unknown as SessionHeader
    if (ids.has(header.id)) throw new Error(`会话 ID 重复： ${header.id}`)
    ids.add(header.id)
    if (
      path !== 'session.v4.jsonl' &&
      path.split('/')[1] !== String(header.id).replace(/[^A-Za-z0-9_-]/gu, '_')
    ) {
      throw new Error(`后代会话条目与其会话 ID 不一致： ${path}`)
    }
    const mappedHeader = { ...header, cwd }
    const events = validateStoredEvents(mappedHeader, [...artifact.events] as unknown as SessionEvent[])
    const inheritedEventCount = SessionLogOffset(artifact.inheritedEventCount)
    Session.fromRestore(
      mappedHeader.id,
      events,
      mappedHeader,
      inheritedEventCount,
      'shared-frozen',
      ctx.sessions.messageProjections,
    )
    sessions.push({ header: mappedHeader, events, inheritedEventCount })
    used.add(path)
  }
  const byId = new Map(sessions.map((session) => [session.header.id, session]))
  const rootId = sessions[0]!.header.id
  for (const session of sessions) {
    const seen = new Set<SessionId>([session.header.id])
    let parent = session.header.parentSession
    while (parent !== undefined && byId.has(parent)) {
      if (seen.has(parent)) throw new Error(`会话谱系包含循环：${parent}`)
      seen.add(parent)
      parent = byId.get(parent)!.header.parentSession
    }
    if (session.header.id !== rootId && !seen.has(rootId))
      throw new Error(`归档中的会话不属于根会话的后代：${session.header.id}`)
  }
  const attachments = new Map<string, ArchiveAttachment>()
  for (const session of sessions) {
    for (const ref of attachmentRefs(session.events)) {
      if (typeof ref !== 'object' || ref === null) throw new Error('附件引用无效')
      const id = String(ref.attachmentId)
      const hash = id.replace(/^sha256:/u, '')
      if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`不支持此附件摘要： ${id}`)
      const path = attachmentPath(ref)
      safePath(path)
      const data = files.get(path)
      if (data === undefined) throw new Error(`引用的附件缺失： ${path}`)
      if (data.length !== ref.bytes || digest(data) !== hash)
        throw new Error(`附件长度或 SHA256 校验不一致： ${path}`)
      const previous = attachments.get(path)
      if (previous !== undefined && attachmentIdentity(previous.ref) !== attachmentIdentity(ref)) {
        throw new Error(`附件引用不一致： ${path}`)
      }
      attachments.set(path, { path, ref, data })
      used.add(path)
    }
  }
  for (const path of files.keys())
    if (!used.has(path)) throw new Error(`ZIP 包含未知或未被引用的条目： ${path}`)
  for (const attachment of attachments.values()) {
    if ('mediaType' in attachment.ref) {
      await ctx.attachments.validateImage({
        data: attachment.data,
        mediaType: attachment.ref.mediaType,
        name: attachment.ref.name,
      })
    }
  }
  return { sessions, attachments: [...attachments.values()] }
}

async function currentDigest(ctx: Context, id: SessionId): Promise<string | null> {
  assertCold(ctx, id)
  let handle: SessionHandle
  try {
    handle = await ctx.sessionPersistence.open(id, 'read')
  } catch (error) {
    if (error instanceof SessionPersistenceNotFoundError) return null
    throw error
  }
  try {
    const { events } = await handle.read()
    assertCold(ctx, id)
    return contentDigest({
      header: handle.header,
      events: [...events],
      inheritedEventCount: handle.inheritedEventCount,
    })
  } finally {
    await handle.close()
  }
}

export async function previewArchive(ctx: Context, bytes: Uint8Array, cwd: string): Promise<ArchivePreview> {
  const target = await targetCwd(cwd)
  const archive = await parseArchive(ctx, bytes, target)
  const facts: Array<[string, string | null]> = []
  for (const session of archive.sessions) {
    facts.push([session.header.id, await currentDigest(ctx, session.header.id)])
  }
  return { expected: { archiveDigest: digest(bytes), cwd: target, sessions: Object.fromEntries(facts) } }
}

export async function importArchive(
  ctx: Context,
  bytes: Uint8Array,
  cwd: string,
  expected: ArchiveExpected,
): Promise<ImportResult> {
  const target = await targetCwd(cwd)
  const archive = await parseArchive(ctx, bytes, target)
  if (ctx.get('workspaceRegistry') === undefined) throw new Error('工作区注册服务不可用')
  if (
    expected === null ||
    typeof expected !== 'object' ||
    expected.archiveDigest !== digest(bytes) ||
    expected.cwd !== target ||
    expected.sessions === null ||
    typeof expected.sessions !== 'object' ||
    Array.isArray(expected.sessions) ||
    Object.keys(expected.sessions).length !== archive.sessions.length
  )
    throw new Error('导入校验与归档、工作目录或会话集合不一致，请重试导入')
  for (const session of archive.sessions) {
    const id = session.header.id
    const current = await currentDigest(ctx, id)
    if (!Object.hasOwn(expected.sessions, id) || current !== expected.sessions[id])
      throw new Error(`会话「${id}」在校验后已发生变化，请重试导入`)
    if (current !== null && current !== contentDigest(session))
      throw new Error(`会话「${id}」与已存储内容冲突，本次没有导入任何会话`)
  }
  const result: ImportResult = { imported: [], skipped: [], incomplete: [] }
  let activeId: string | undefined
  try {
    const workspace = await ctx.workspaceRegistry.create(target)
    for (const attachment of archive.attachments) {
      const ref = attachment.ref
      const saved =
        'mediaType' in ref
          ? await ctx.attachments.saveImage({
              data: attachment.data,
              mediaType: ref.mediaType,
              name: ref.name,
            })
          : await ctx.attachments.saveFileStream({
              data: (async function* () {
                yield attachment.data
              })(),
              name: ref.name,
            })
      if (attachmentIdentity(saved) !== attachmentIdentity(ref))
        throw new Error(`附件存储服务改变了归档字节或元数据： ${attachment.path}；尚未写入会话日志`)
    }
    for (const session of archive.sessions) {
      const id = session.header.id
      activeId = id
      const current = await currentDigest(ctx, id)
      if (current !== expected.sessions[id]) throw new Error(`会话「${id}」在导入过程中发生了变化`)
      if (current !== null) {
        result.skipped.push(id)
        if (session.header.origin !== 'subagent') await workspace.attachSession(id)
        continue
      }
      assertCold(ctx, id)
      const handle = await ctx.sessionPersistence.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
      })
      result.incomplete.push(id)
      const failures: unknown[] = []
      try {
        if (contentDigest({ ...session, header: handle.header }) !== contentDigest(session))
          throw new Error(`持久化服务改变了会话「${id}」的头部`)
        await handle.append(session.events)
        await handle.flush()
      } catch (error) {
        failures.push(error)
      }
      try {
        await handle.close()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          failures.map((error) => (error instanceof Error ? error.message : String(error))).join('；'),
        )
      result.incomplete.splice(result.incomplete.indexOf(id), 1)
      result.imported.push(id)
      if (session.header.origin !== 'subagent') await workspace.attachSession(id)
    }
  } catch (error) {
    result.failure = {
      ...(activeId === undefined ? {} : { id: activeId }),
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  return result
}

export function describeActivity(activity: readonly SessionActivity[]): string {
  return activity
    .map((entry) =>
      entry.items?.length
        ? `${entry.kind}：${entry.items.map((item) => item.label ?? item.id).join('、')}`
        : entry.kind,
    )
    .join('、')
}

/** 官方删除契约外的受控文件删除：stat 确认后按官方布局定位，写锁尽力互斥；返回是否移除了文件。 */
export async function deleteSessionFiles(
  ctx: Context,
  sessionsRoot: string,
  id: SessionId,
): Promise<boolean> {
  if ((await ctx.sessionPersistence.stat(id)) === undefined) return false
  const dir = await locateSessionDir(sessionsRoot, id)
  // 写锁尽力闸门：抢到锁则持锁删除（防其他进程并发写）。宿主进程对已加载
  // 会话长期持有写句柄且归档不释放它，占用错误只可能是宿主自身的空闲句柄
  // ——归档集成员已保证无活动，继续删除；其余错误拒绝。
  let handle: SessionHandle | undefined
  try {
    handle = await ctx.sessionPersistence.open(id, 'write')
  } catch (error) {
    if (!(error instanceof SessionAlreadyOwnedError)) throw error
  }
  try {
    await rm(dir, { recursive: true, force: false })
    return true
  } finally {
    // 删除结果已定，关闭句柄失败不回滚也不阻断归档条目清理。
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // 忽略：数据已删除，后续 unarchive 才是用户可见状态。
      }
    }
  }
}

/** 用官方导出库产出整棵会话树（含子会话）的官方 ZIP 字节，累计不超过导入同款 64 MiB 上限。 */
export async function exportSessionArchive(ctx: Context, id: SessionId): Promise<Uint8Array> {
  const deps = sessionLogExportDeps(ctx)
  if (
    deps.sessionQuery === undefined ||
    deps.sessionPersistence === undefined ||
    deps.attachments === undefined
  ) {
    throw new Error('官方会话导出服务不可用：缺少 session-query、session-persistence 或附件服务')
  }
  await flushLiveSessionLog(deps, id)
  const root = await readSessionLogText(deps.sessionPersistence, id)
  if (root === undefined) throw new Error(`会话「${id}」没有已存储的日志，无法导出`)
  const signal = new AbortController()
  const stream = streamSessionLogZip(
    {
      sessionQuery: deps.sessionQuery,
      sessionPersistence: deps.sessionPersistence,
      attachments: deps.attachments,
      sessions: deps.sessions,
    },
    root,
    id,
    true,
    DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
    signal.signal,
  )
  const chunks: Uint8Array[] = []
  let total = 0
  let overflow = false
  for await (const chunk of stream) {
    total += chunk.byteLength
    if (total > MAX_ARCHIVE_BYTES) {
      overflow = true
      break
    }
    chunks.push(chunk)
  }
  if (overflow) {
    signal.abort()
    throw new Error('导出归档超过 64 MiB 上限，无法迁移')
  }
  const archive = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.byteLength
  }
  return archive
}

export interface MigrateInput {
  sessionId: string
  workspaceId: string
}

/**
 * 受控迁移：官方工作区成员资格按会话日志头 cwd 派生，attach 到不同路径的工作区被官方
 * 拒绝，契约内没有跨工作区移动。这里把迁移编排为「官方导出 → 归档 → 受控删除 → 导入到
 * 目标工作区」，逐道闸门显式拒绝；日志已删除而导入未完成时把导出 ZIP 随失败结果返回，
 * 由用户在导入页手动恢复。目标只接受工作区注册表中的工作区，不接受裸路径。
 */
export async function migrateSession(
  ctx: Context,
  sessionsRoot: string,
  input: MigrateInput,
): Promise<MigrateResult> {
  const id = input.sessionId as SessionId
  const workspace = ctx.workspaceRegistry.get(input.workspaceId as WorkspaceId)
  if (workspace === undefined) throw new HttpError(400, '目标工作区不存在，请重新选择')
  const target = await targetCwd(workspace.path)
  const stored = await ctx.sessionPersistence.stat(id)
  if (stored === undefined) throw new HttpError(409, '会话没有已存储的日志，无法迁移')
  if (stored.header.origin === 'subagent') throw new HttpError(409, '子会话不提供迁移，请迁移其主会话')
  if (stored.header.cwd !== undefined) {
    let current: string | undefined
    try {
      current = await realpath(stored.header.cwd)
    } catch {
      // 原目录已不存在或不可解析时匹配不到任何工作区，继续迁移。
    }
    if (current === target) {
      // 快路径：规范 cwd 已等于目标路径，官方 attach 的强校验必过——只补账本成员资格，
      // 不走导出-删除-导入；这正是「cwd 正确却停留在未分组」会话的修复入口。
      try {
        await workspace.attachSession(id)
      } catch (error) {
        return { ok: false, stage: 'attach', error: errMsg(error) }
      }
      return { ok: true, filesRemoved: false, attached: true }
    }
  }
  // 导入要在删除后重建同 ID 会话；宿主仍加载该会话时官方持久化拒绝 create，
  // 只会在删除后才失败，因此加载检查必须放在任何破坏性步骤之前。
  if (ctx.sessions.get(id) !== undefined) {
    return { ok: false, stage: 'loaded', error: '会话仍加载在宿主内存中' }
  }
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () =>
    Promise.resolve([]),
  )
  if (activity.length > 0) return { ok: false, stage: 'activity', error: describeActivity(activity) }

  let archive: Uint8Array
  try {
    archive = await exportSessionArchive(ctx, id)
  } catch (error) {
    return { ok: false, stage: 'export', error: errMsg(error) }
  }
  try {
    // 不带 stopActivity：闸门间隙出现活动时显式拒绝，而不是替用户停止工作。
    await ctx.workspaceRegistry.archiveSession(id, {})
  } catch (error) {
    return { ok: false, stage: 'archive', error: errMsg(error) }
  }
  // 「归档时无活动」只是归档那一刻的检查；删除前用官方同一 waterfall 复查，
  // 把删除窗口内本实例的回合、子代理、后台任务与定时任务挡在门外。
  const repeat = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () =>
    Promise.resolve([]),
  )
  if (repeat.length > 0) {
    return {
      ok: false,
      stage: 'activity',
      error: `${describeActivity(repeat)}；会话已进入归档集，可在「设置 → 会话」恢复`,
    }
  }

  let filesRemoved: boolean
  try {
    filesRemoved = await deleteSessionFiles(ctx, sessionsRoot, id)
  } catch (error) {
    return { ok: false, stage: 'delete', error: errMsg(error) }
  }
  let archiveClearError: string | undefined
  try {
    await ctx.workspaceRegistry.unarchiveSession(id)
  } catch (error) {
    archiveClearError = errMsg(error)
  }

  try {
    // 删除后再预览：全部会话的当前摘要必须为空，导出字节就是唯一事实。
    const preview = await previewArchive(ctx, archive, target)
    const result = await importArchive(ctx, archive, target, preview.expected)
    if (result.failure !== undefined) throw new Error(result.failure.reason)
  } catch (error) {
    return {
      ok: false,
      stage: 'import',
      error: errMsg(error),
      recoverable: { archive: Buffer.from(archive).toString('base64'), cwd: target },
    }
  }
  return { ok: true, filesRemoved, ...(archiveClearError !== undefined && { archiveClearError }) }
}
