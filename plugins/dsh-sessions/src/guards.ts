import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, parse } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import { HttpError } from '@dsh-plugins/shared/http'

/** 各操作共用的受控闸门：目标目录、加载状态、活动复查与写锁尽力互斥。 */

export function describeActivity(activity: readonly SessionActivity[]): string {
  return activity
    .map((entry) =>
      entry.items?.length
        ? `${entry.kind}：${entry.items.map((item) => item.label ?? item.id).join('、')}`
        : entry.kind,
    )
    .join('、')
}

export async function targetCwd(cwd: string): Promise<string> {
  if (
    typeof cwd !== 'string' ||
    cwd.trim() === '' ||
    !isAbsolute(cwd) ||
    cwd.includes('\0') ||
    (process.platform === 'win32' && ['\\', '/'].includes(parse(cwd).root))
  ) {
    throw new HttpError(400, '目标工作目录必须是本机存在的绝对目录')
  }
  const canonical = await realpath(cwd)
  if (!(await stat(canonical)).isDirectory()) throw new HttpError(400, `目标工作目录不是目录：${cwd}`)
  return canonical
}

/** 已加载的会话由宿主持有活内存态与追加路径，绕过它做磁盘手术会制造僵尸写入；一律拒绝。 */
export function assertNotLoaded(ctx: Context, id: SessionId): void {
  if (ctx.sessions.get(id) !== undefined) {
    throw new HttpError(409, `会话「${id}」仍加载在宿主内存中，请重启宿主或关闭该会话后重试`)
  }
}

/** 删除时刻经官方活动 waterfall 复查：仍有回合、子代理、后台任务或定时活动即拒绝。 */
export async function assertIdle(ctx: Context, id: SessionId): Promise<void> {
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () =>
    Promise.resolve([]),
  )
  if (activity.length > 0) {
    throw new HttpError(409, `会话仍有进行中的活动，已拒绝：${describeActivity(activity)}`)
  }
}

/**
 * 写锁尽力闸门：抢到官方写锁则持锁操作（防其他进程并发写）。宿主对已加载会话长期持有
 * 写句柄且不释放，占用错误只可能是宿主自身的空闲句柄——已由加载检查挡住活跃写入，
 * 其余错误显式拒绝。返回 `undefined` 表示锁被宿主空闲句柄占用，按既有边界继续。
 */
export async function acquireWriteLock(ctx: Context, id: SessionId): Promise<SessionHandle | undefined> {
  try {
    return await ctx.sessionPersistence.open(id, 'write')
  } catch (error) {
    if (error instanceof SessionAlreadyOwnedError) return undefined
    throw error
  }
}

export async function releaseLock(handle: SessionHandle | undefined): Promise<void> {
  if (handle === undefined) return
  try {
    await handle.close()
  } catch {
    // 数据操作结果已定，锁释放失败不回滚也不阻断后续清理。
  }
}
