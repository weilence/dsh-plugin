import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError } from '@dsh-plugins/shared/http'
import { assertIdle, assertNotLoaded, acquireWriteLock, releaseLock, targetCwd } from './guards'
import {
  assertSessionDirectory,
  assertSessionId,
  encodeArtifactBytes,
  encodeIdSegment,
  encodeProjectKey,
  locateSessionArtifact,
  readSessionArtifactFile,
  writeTempFile,
} from './surgery'

/**
 * 原地跨工作区迁移：改写日志头 cwd 并把工件发布到目标项目目录，历史事件逐字节保留。
 * 冷会话限定——活会话需要重绑宿主内部写入路径，官方契约不暴露，已加载一律拒绝。
 */

export interface MigrateResult {
  ok: true
  moved: boolean
  attached: boolean
  membershipPending?: string
}

export interface MigrateInput {
  sessionId: string
  workspaceId: string
}

/**
 * 官方注册表把会话头缓存在私有 Map（启动时从持久化现扫建立，命中即不再刷新）。
 * 磁盘手术后按特性探测补缓存，让 `attachSession` 的 cwd 强校验读到新值；
 * 探测不到返回 `false`，调用方引导重启后走快路径补挂。
 */
function refreshRegistryHeaderCache(ctx: Context, header: SessionHeader, canonicalCwd: string): boolean {
  const registry = ctx.workspaceRegistry as unknown as {
    headers?: Map<string, unknown>
    sessionPaths?: Map<string, string>
    missingSessionPaths?: Set<string>
    invalidSessionPaths?: Map<string, unknown>
  }
  if (
    !(registry.headers instanceof Map) ||
    !(registry.sessionPaths instanceof Map) ||
    !(registry.missingSessionPaths instanceof Set) ||
    !(registry.invalidSessionPaths instanceof Map)
  ) {
    return false
  }
  registry.headers.set(header.id, header)
  registry.sessionPaths.set(header.id, canonicalCwd)
  registry.missingSessionPaths.delete(header.id)
  registry.invalidSessionPaths.delete(header.id)
  return true
}

/**
 * 冷会话的工作目录投影从事件日志折叠，不从日志头 cwd 重新初始化：日志里已有
 * `working-directory/change` 历史时必须补记一条新事件，否则恢复后回到旧目录。
 * 只有全部行可解析且 seq 与行号连续时才能安全追加（与宿主 append 的包络一致）。
 */
function rehomeColdWorkingDirectory(bodyText: string, targetPath: string): string {
  if (bodyText === '') return bodyText
  const lines = bodyText.slice(0, -1).split('\n')
  let lastChange: string | undefined
  let sequential = true
  for (const [index, line] of lines.entries()) {
    let event: { seq?: unknown; type?: unknown; data?: { cwd?: unknown } }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      sequential = false
      continue
    }
    if (event.seq !== index) sequential = false
    if (event.type === 'working-directory/change' && typeof event.data?.cwd === 'string') {
      lastChange = event.data.cwd
    }
  }
  if (lastChange === undefined || lastChange === targetPath) return bodyText
  if (!sequential) {
    throw new HttpError(
      409,
      '会话日志存在非连续 seq 或不可解析行，无法安全同步工作目录，已取消迁移；原始会话保持原状',
    )
  }
  const appended = JSON.stringify({
    type: 'working-directory/change',
    seq: lines.length,
    time: Date.now(),
    data: { cwd: targetPath },
  })
  return `${bodyText}${appended}\n`
}

export async function migrateSession(
  ctx: Context,
  sessionsRoot: string,
  input: MigrateInput,
): Promise<MigrateResult> {
  const id = assertSessionId(input.sessionId)
  const workspace = ctx.workspaceRegistry.get(input.workspaceId as WorkspaceId)
  if (workspace === undefined) throw new HttpError(400, '目标工作区不存在，请重新选择')
  const targetPath = await targetCwd(workspace.path)
  const snapshot = await ctx.sessionPersistence.stat(id)
  if (snapshot === undefined) throw new HttpError(409, '会话没有已存储的日志，无法迁移')
  if (snapshot.header.origin === 'subagent') throw new HttpError(409, '子会话不提供迁移，请迁移其主会话')
  if (snapshot.formatStatus === 'migration-required') {
    throw new HttpError(409, '会话日志是旧代格式，请先在宿主中打开该会话完成格式升级后重试')
  }
  if (snapshot.header.cwd !== undefined) {
    let current: string | undefined
    try {
      current = await realpath(snapshot.header.cwd)
    } catch {
      // 原目录已不存在或不可解析时匹配不到任何工作区，继续迁移。
    }
    if (current === targetPath) {
      // 快路径：规范 cwd 已等于目标路径，官方 attach 的强校验必过——只补账本成员资格。
      await workspace.attachSession(id)
      return { ok: true, moved: false, attached: true }
    }
  }
  assertNotLoaded(ctx, id)
  await assertIdle(ctx, id)

  const handle = await acquireWriteLock(ctx, id)
  try {
    const artifact = await locateSessionArtifact(sessionsRoot, id)
    await assertSessionDirectory(sessionsRoot, artifact.dir, id)
    const content = await readSessionArtifactFile(join(artifact.dir, artifact.filename), artifact.zstd)
    if (content.header.id !== id) throw new HttpError(409, '会话工件头行 id 与请求不符，拒绝迁移')

    const bodyText = rehomeColdWorkingDirectory(content.bodyText, targetPath)
    const headerText = JSON.stringify({ ...content.header, cwd: targetPath })
    const bytes = await encodeArtifactBytes(headerText, bodyText, artifact.zstd)

    const toDir = join(sessionsRoot, encodeProjectKey(targetPath), encodeIdSegment(id))
    await mkdir(toDir, { recursive: true })
    await assertSessionDirectory(sessionsRoot, toDir, id)
    const newPath = join(toDir, artifact.filename)
    const occupied = await stat(newPath).then(
      () => true,
      (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      },
    )
    if (artifact.dir !== toDir && occupied) {
      throw new HttpError(409, `目标位置已有会话工件，拒绝覆盖：${newPath}`)
    }
    const hidden = `${join(artifact.dir, artifact.filename)}.${randomBytes(6).toString('hex')}.bak`
    // 先隐藏旧工件（非规范文件名对官方后端不可见），再发布新工件；崩溃时宁可短暂缺失也不出现重复 id。
    await rename(join(artifact.dir, artifact.filename), hidden)
    try {
      const temp = await writeTempFile(newPath, bytes)
      await rename(temp, newPath)
    } catch (error) {
      try {
        await rename(hidden, join(artifact.dir, artifact.filename))
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `迁移发布失败且回滚失败；原始会话保留在 ${hidden}，新文件留在 ${toDir}`,
        )
      }
      throw new HttpError(500, `迁移发布失败，原始会话已恢复: ${errMsg(error)}`)
    }
    await rm(artifact.dir, { recursive: true, force: true })
  } finally {
    await releaseLock(handle)
  }

  // 文件已在新位置；后续账本失败不再回滚文件——会话数据一致，归属可经快路径补挂。
  let attached = false
  let membershipPending: string | undefined
  const fresh = await ctx.sessionPersistence.stat(id)
  if (fresh !== undefined && refreshRegistryHeaderCache(ctx, fresh.header, targetPath)) {
    try {
      await workspace.attachSession(id)
      attached = true
    } catch (error) {
      membershipPending = errMsg(error)
    }
  } else {
    membershipPending = '宿主工作区注册表不支持在线补挂'
  }
  const detachErrors: string[] = []
  for (const entity of ctx.workspaceRegistry.list()) {
    if (entity.id === workspace.id) continue
    try {
      await entity.detachSession(id)
    } catch (error) {
      detachErrors.push(errMsg(error))
    }
  }
  if (!attached) {
    membershipPending =
      `已迁移文件，但归入目标工作区失败：${membershipPending ?? '未知原因'}。` +
      '请重启宿主后再次迁移（将走快路径）完成归属'
  }
  if (detachErrors.length > 0 && membershipPending === undefined) {
    membershipPending = `已迁移，但从旧工作区移除失败：${detachErrors.join('；')}；旧条目会在下次宿主重启后自动清理`
  }
  return { ok: true, moved: true, attached, ...(membershipPending !== undefined && { membershipPending }) }
}
