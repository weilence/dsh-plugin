import { rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError } from '@dsh-plugins/shared/http'
import { assertIdle, assertNotLoaded, acquireWriteLock, releaseLock } from './guards'
import { assertSessionDirectory, assertSessionId, locateSessionArtifact } from './surgery'

/** 级联删除：发现全部子代理后代，先全量预检再后代逆序删除；账本与归档条目随后清理。 */

export interface DeleteResult {
  filesRemoved: boolean
  archiveCleared: boolean
  archiveClearError?: string
  deletedSubagents: SessionId[]
}

/** 官方持久化头现扫后代谱系（`origin === 'subagent'` 且 `parentSession` 成链）；扫描失败即拒绝。 */
export async function findDescendantSubagents(ctx: Context, rootId: SessionId): Promise<SessionId[]> {
  const snapshots = await ctx.sessionPersistence.list()
  const childrenOf = new Map<SessionId, SessionId[]>()
  for (const snapshot of snapshots) {
    const { id, origin, parentSession } = snapshot.header
    if (origin !== 'subagent' || parentSession === undefined || id === rootId) continue
    const siblings = childrenOf.get(parentSession) ?? []
    siblings.push(id)
    childrenOf.set(parentSession, siblings)
  }
  const descendants: SessionId[] = []
  let frontier: SessionId[] = [rootId]
  while (frontier.length > 0) {
    const next: SessionId[] = []
    for (const parent of frontier) {
      for (const child of childrenOf.get(parent) ?? []) {
        descendants.push(child)
        next.push(child)
      }
    }
    frontier = next
  }
  return descendants
}

/** 删除单个会话的日志目录：官方 stat 确认、目录边界校验、写锁尽力互斥。 */
export async function deleteSessionFiles(
  ctx: Context,
  sessionsRoot: string,
  id: SessionId,
): Promise<boolean> {
  if ((await ctx.sessionPersistence.stat(id)) === undefined) return false
  const artifact = await locateSessionArtifact(sessionsRoot, id)
  await assertSessionDirectory(sessionsRoot, artifact.dir, id)
  const handle = await acquireWriteLock(ctx, id)
  try {
    await rm(artifact.dir, { recursive: true, force: false })
    return true
  } finally {
    await releaseLock(handle)
  }
}

export async function deleteSessionCascade(
  ctx: Context,
  sessionsRoot: string,
  rawId: string,
): Promise<DeleteResult> {
  const id = assertSessionId(rawId)
  const descendants = await findDescendantSubagents(ctx, id)
  const targets = [id, ...descendants]
  // 预检全部通过才动任何数据：加载、活动与目录定位逐项前置。
  for (const target of targets) {
    assertNotLoaded(ctx, target)
    await assertIdle(ctx, target)
    if ((await ctx.sessionPersistence.stat(target)) !== undefined) {
      const artifact = await locateSessionArtifact(sessionsRoot, target)
      await assertSessionDirectory(sessionsRoot, artifact.dir, target)
    }
  }
  const deletedSubagents: SessionId[] = []
  for (const subId of [...descendants].reverse()) {
    try {
      await deleteSessionFiles(ctx, sessionsRoot, subId)
      deletedSubagents.push(subId)
    } catch (error) {
      const remaining = descendants.filter((candidate) => !deletedSubagents.includes(candidate))
      throw new HttpError(
        500,
        `删除子会话「${subId}」失败: ${errMsg(error)}。已删除：${deletedSubagents.join('、') || '无'}；` +
          `剩余：${[...remaining, id].join('、')}`,
      )
    }
  }
  const filesRemoved = await deleteSessionFiles(ctx, sessionsRoot, id)

  let archiveCleared = true
  const archiveClearErrors: string[] = []
  for (const target of targets) {
    try {
      await ctx.workspaceRegistry.unarchiveSession(target)
    } catch (error) {
      archiveCleared = false
      archiveClearErrors.push(errMsg(error))
    }
  }
  for (const entity of ctx.workspaceRegistry.list()) {
    try {
      await entity.detachSession(id)
    } catch (error) {
      archiveCleared = false
      archiveClearErrors.push(errMsg(error))
    }
  }
  return {
    filesRemoved,
    archiveCleared,
    ...(archiveClearErrors.length > 0 && { archiveClearError: archiveClearErrors.join('；') }),
    deletedSubagents,
  }
}
