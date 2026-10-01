import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, parse } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { Zip, ZipDeflate } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import {
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipEntries,
} from '@deepseek-ai/dsh-session-log-export'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { SessionPersistenceNotFoundError, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_SESSIONS,
  MAX_ENTRY_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_LOG_BYTES,
  MAX_SESSION_EVENTS,
} from './shared.js'
import type { ArchiveExpected, ArchivePreview, ImportResult } from './shared.js'

interface ArchiveSession {
  header: SessionHeader
  events: SessionEvent[]
  inheritedEventCount: SessionLogOffset
  sourceCwd?: string
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

function contentDigest(session: Omit<ArchiveSession, 'sourceCwd'>): string {
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

async function parseArchive(ctx: Context, bytes: Uint8Array, cwd?: string): Promise<ParsedArchive> {
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
    const mappedHeader = cwd === undefined ? header : { ...header, cwd }
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
    sessions.push({ header: mappedHeader, events, inheritedEventCount, sourceCwd: header.cwd })
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
  const sessions: ArchivePreview['sessions'] = []
  for (const session of archive.sessions) {
    const present = await currentDigest(ctx, session.header.id)
    facts.push([session.header.id, present])
    sessions.push({
      id: session.header.id,
      eventCount: session.events.length,
      cwd: session.sourceCwd,
      status: present === null ? 'new' : present === contentDigest(session) ? 'same' : 'conflict',
    })
  }
  return {
    expected: { archiveDigest: digest(bytes), cwd: target, sessions: Object.fromEntries(facts) },
    sessions,
    warnings: ['cwd-history-unchanged', 'cold-storage-only', 'non-atomic-tree-snapshot'],
  }
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
    throw new Error('导入确认与归档、工作目录或会话集合不一致，请重新预览')
  for (const session of archive.sessions) {
    const id = session.header.id
    const current = await currentDigest(ctx, id)
    if (!Object.hasOwn(expected.sessions, id) || current !== expected.sessions[id])
      throw new Error(`会话「${id}」在预览后已发生变化，请重新预览`)
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

export async function exportArchive(ctx: Context, id: string): Promise<Uint8Array> {
  const sessionId = SessionId(id)
  const deps = sessionLogExportDeps(ctx)
  if (!deps.sessionQuery || !deps.sessionPersistence || !deps.attachments || !deps.sessions)
    throw new Error('官方会话导出服务不可用')
  await flushLiveSessionLog(deps, sessionId)
  const root = await readSessionLogText(deps.sessionPersistence, sessionId)
  if (root === undefined) throw new Error(`会话「${id}」没有已存储的日志`)
  if (root.length > MAX_LOG_BYTES) throw new Error('会话日志超过 16 MiB 上限')
  const chunks: Uint8Array[] = []
  let size = 0
  let expanded = 0
  let entryCount = 0
  let sessionCount = 0
  let failure: Error | undefined
  const zip = new Zip((error, data) => {
    if (error) {
      failure = error
      return
    }
    size += data.byteLength
    if (size > MAX_ARCHIVE_BYTES) {
      failure = new Error('导出归档超过 64 MiB 上限')
      return
    }
    chunks.push(data)
  })
  try {
    for await (const entry of sessionLogZipEntries(
      {
        ...deps,
        sessionQuery: deps.sessionQuery,
        sessionPersistence: deps.sessionPersistence,
        attachments: deps.attachments,
      },
      root,
      sessionId,
      true,
    )) {
      if (++entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('ZIP 条目数量超过上限')
      safePath(entry.path)
      const isLog = 'content' in entry
      if (isLog && ++sessionCount > MAX_ARCHIVE_SESSIONS) throw new Error('归档会话数量超过上限')
      const deflate = new ZipDeflate(entry.path, { level: 6 })
      zip.add(deflate)
      let entryBytes = 0
      const push = (data: Uint8Array): void => {
        entryBytes += data.byteLength
        expanded += data.byteLength
        if (entryBytes > (isLog ? MAX_LOG_BYTES : MAX_ENTRY_BYTES) || expanded > MAX_EXPANDED_BYTES)
          throw new Error('ZIP 解压大小超过上限')
        for (let offset = 0; offset < data.byteLength; offset += 65536) {
          deflate.push(data.subarray(offset, offset + 65536), false)
          if (failure) throw failure
        }
      }
      if ('content' in entry) {
        if (entry.content.length > MAX_LOG_BYTES) throw new Error(`会话日志超过 16 MiB 上限: ${entry.path}`)
        push(new TextEncoder().encode(entry.content))
      } else if ('data' in entry) {
        push(entry.data)
      } else {
        for await (const data of entry.chunks) push(data)
      }
      deflate.push(new Uint8Array(), true)
      if (failure) throw failure
    }
    zip.end()
    if (failure) throw failure
  } catch (error) {
    zip.terminate()
    throw error
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  await parseArchive(ctx, bytes)
  return bytes
}
