import { randomBytes } from 'node:crypto'
import { lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError } from '@dsh-plugins/shared/http'

/**
 * 官方持久化后端的受控磁盘手术原语。布局与编码对齐 DSH 0.2.1-rc.2 的
 * session-persistence-jsonl：`<root>/<projectKey(cwd)>/<encodeSegment(id)>/session.vN.jsonl[.zstd]`，
 * zstd 工件是独立帧串联且头行独占第一帧。
 */

/** 会话 id 是未校验的品牌字符串；进入文件系统前拒绝路径片段与控制字符。 */
export function assertSessionId(id: string): SessionId {
  if (
    id.trim() === '' ||
    id === '.' ||
    id === '..' ||
    /[\\/\u0000-\u001f<>"|?*]/u.test(id) ||
    /[. ]$/u.test(id)
  ) {
    throw new HttpError(400, 'sessionId 必须是合法的会话标识，不能包含路径或特殊目录名')
  }
  return id as SessionId
}

/** 官方后端未导出 encodeSegment；按其磁盘布局规则编码会话 id 为目录名。 */
export function encodeIdSegment(id: string): string {
  if (id === '.') return '~002E'
  if (id === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index)
    const ch = String.fromCharCode(code)
    out +=
      ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** 官方后端未导出 projectKey；按其磁盘布局规则编码 cwd 为项目目录名（分隔符折叠为 `-`，有损截断）。 */
export function encodeProjectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}

export interface SessionArtifact {
  dir: string
  filename: string
  version: number
  zstd: boolean
}

const LOG_NAME = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/u

/** 与官方 parseGenerationLogFilename 同口径：临时名、大写、前导零、`.v0` 标记不算已提交代。 */
export function canonicalLogName(name: string): { version: number; zstd: boolean } | undefined {
  const match = LOG_NAME.exec(name)
  if (match === null) return undefined
  return { version: match[1] !== undefined ? Number(match[1]) : 0, zstd: match[2] !== undefined }
}

/**
 * 在存储根目录下现扫定位会话工件（官方后端同款语义：每代取数值最高的规范文件名，
 * 不含规范日志的目录视为此处无会话）。存储根由 `sessionsRoot` 配置或官方 home 约定解析。
 */
export async function locateSessionArtifact(root: string, id: string): Promise<SessionArtifact> {
  const target = encodeIdSegment(id)
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(
        409,
        `会话存储根目录不存在：${root}。请在 dsh-sessions 配置 sessionsRoot 指向实际目录`,
      )
    }
    throw error
  }
  const matches: SessionArtifact[] = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name, target)
    let entries
    try {
      entries = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    let newest: { filename: string; version: number; zstd: boolean } | undefined
    for (const name of entries) {
      const parsed = canonicalLogName(name)
      if (parsed !== undefined && (newest === undefined || parsed.version > newest.version)) {
        newest = { filename: name, ...parsed }
      }
    }
    if (newest !== undefined) matches.push({ dir, ...newest })
  }
  // 与官方 findLog 同口径：同一 id 出现在多个项目目录是异常状态，拒绝猜测。
  if (matches.length > 1) {
    throw new HttpError(409, `会话 ${id} 的日志同时出现在多个项目目录下，已拒绝操作；请先清理重复目录`)
  }
  if (matches.length === 1) return matches[0]!
  throw new HttpError(
    409,
    `未能在会话存储根目录 ${root} 下定位会话 ${id} 的目录。若存储根已自定义，请在 dsh-sessions 配置 sessionsRoot`,
  )
}

/** 只有真实的 `<root>/<项目目录>/<会话目录>` 两层目录可被改动；逐级拒绝符号链接与 junction。 */
export async function assertSessionDirectory(root: string, dir: string, id: string): Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(dir)) throw new Error('无法验证会话目录，已停止文件操作')
  const parts = relative(root, dir).split(sep)
  if (
    parts.length !== 2 ||
    parts.some((part) => part === '' || part === '.' || part === '..') ||
    parts[1] !== encodeIdSegment(id)
  ) {
    throw new Error('会话目录超出允许范围，已停止文件操作')
  }
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('会话目录不能是符号链接、junction 或普通文件')
    }
  }
}

const ZSTD_MAGIC = 0xfd2fb528

/** 结构化扫描 zstd 帧边界（不解码）：完整帧区间与可选的截断尾帧起点。 */
function scanZstdFrames(buffer: Buffer): { frames: Array<[number, number]>; tornStart?: number } {
  const frames: Array<[number, number]> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    const torn = (): { frames: Array<[number, number]>; tornStart: number } => ({ frames, tornStart: start })
    if (buffer.length - offset < 4) return torn()
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`Zstandard 会话日志帧魔数无效：字节 ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return torn()
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`Zstandard 会话日志保留头位被置位：字节 ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return torn()
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return torn()
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`Zstandard 会话日志保留块类型：字节 ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return torn()
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return torn()
      offset += 4
    }
    frames.push([start, offset])
  }
  return { frames }
}

type ZstdCodec = {
  compress: (input: Buffer) => Promise<Buffer>
  decompress: (input: Buffer) => Promise<Buffer>
}

async function zstdCodec(): Promise<ZstdCodec> {
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdCompress !== 'function' || typeof zlib.zstdDecompress !== 'function') {
    throw new HttpError(503, '当前 Node 运行时没有 zstd 支持，无法操作 zstd 编码的会话工件')
  }
  return {
    compress: promisify(zlib.zstdCompress),
    decompress: promisify(zlib.zstdDecompress),
  }
}

export interface ArtifactContent {
  header: Record<string, unknown>
  headerText: string
  bodyText: string
}

function parsePlainText(text: string): ArtifactContent {
  const newlineAt = text.indexOf('\n')
  if (newlineAt === -1) throw new HttpError(409, '会话工件缺少头行，数据可能损坏')
  if (!text.endsWith('\n')) throw new HttpError(409, '会话日志存在不完整的尾行，拒绝改写')
  const headerText = text.slice(0, newlineAt)
  try {
    return {
      header: JSON.parse(headerText) as Record<string, unknown>,
      headerText,
      bodyText: text.slice(newlineAt + 1),
    }
  } catch (error) {
    throw new HttpError(409, `会话工件头行无法解析: ${errMsg(error)}`)
  }
}

/** 全量读取工件并解码为明文；截断的 zstd 帧或不完整尾行一律拒绝改写，绝不发布部分历史。 */
export async function readSessionArtifactFile(path: string, zstd: boolean): Promise<ArtifactContent> {
  const bytes = await readFile(path)
  if (!zstd) return parsePlainText(bytes.toString('utf8'))
  const { frames, tornStart } = scanZstdFrames(bytes)
  if (tornStart !== undefined) {
    throw new HttpError(409, '会话日志存在截断的 Zstd 帧，拒绝改写；请先在宿主中打开该会话修复后重试')
  }
  const codec = await zstdCodec()
  const decoded: Buffer[] = []
  for (const [start, end] of frames) decoded.push(await codec.decompress(bytes.subarray(start, end)))
  return parsePlainText(Buffer.concat(decoded).toString('utf8'))
}

/** 重编码保持后端容器契约：头行独占第一帧，正文整体为第二帧；纯文本按 JSONL 拼接。 */
export async function encodeArtifactBytes(
  headerText: string,
  bodyText: string,
  zstd: boolean,
): Promise<Buffer> {
  if (!zstd) return Buffer.from(`${headerText}\n${bodyText}`, 'utf8')
  const codec = await zstdCodec()
  const headerFrame = await codec.compress(Buffer.from(`${headerText}\n`, 'utf8'))
  if (bodyText === '') return headerFrame
  return Buffer.concat([headerFrame, await codec.compress(Buffer.from(bodyText, 'utf8'))])
}

export async function writeTempFile(finalPath: string, bytes: Buffer): Promise<string> {
  const temp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
  } catch (error) {
    try {
      await handle.close()
    } catch {
      // 保留原始写入错误
    }
    await rm(temp, { force: true })
    throw error
  }
  return temp
}

/** 备份、发布、回滚三段式替换；回滚失败保留备份并把恢复路径原样交给调用方。 */
export async function replaceSessionFile(path: string, bytes: Buffer): Promise<{ backupPath?: string }> {
  const temp = await writeTempFile(path, bytes)
  const backup = `${path}.${randomBytes(6).toString('hex')}.bak`
  await rename(path, backup)
  try {
    await rename(temp, path)
  } catch (error) {
    try {
      await rename(backup, path)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `发布失败且回滚失败；原始会话保留在 ${backup}，新文件保留在 ${temp}`,
      )
    }
    await rm(temp, { force: true })
    throw new HttpError(500, `发布失败，原始会话已恢复: ${errMsg(error)}`)
  }
  const removed = await rm(backup, { force: true }).then(
    () => true,
    () => false,
  )
  return removed ? {} : { backupPath: backup }
}
