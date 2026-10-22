import type { Context } from '@deepseek-ai/cordis'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError } from '@dsh-plugins/shared/http'
import { deleteSessionCascade } from './delete'
import { migrateSession } from './move'
import { migratePreset } from './preset'
import { assertSessionId } from './surgery'
import { MAX_BATCH_SESSIONS } from './shared'
import type {
  BatchAction,
  BatchItem,
  BatchRequest,
  DeleteResult,
  MigrateResult,
  PresetResult,
} from './shared'

/**
 * 批量编排：去重与上限前置校验后逐项执行单项操作——单项闸门失败只记为该项
 * 失败并继续；删除维护级联已覆盖集，父子同批时后到者标记 cascaded。
 */

type BatchOutcome = DeleteResult | MigrateResult | PresetResult

export async function runBatch(
  ctx: Context,
  sessionsRoot: string,
  request: BatchRequest,
): Promise<BatchItem[]> {
  const action: BatchAction = request.action
  if (action !== 'delete' && action !== 'migrate' && action !== 'preset') {
    throw new HttpError(400, `action 不支持: ${String(action)}`)
  }
  if (!Array.isArray(request.sessionIds)) throw new HttpError(400, 'sessionIds 必须是数组')
  const ids = [...new Set(request.sessionIds.filter((id) => typeof id === 'string' && id.trim() !== ''))]
  for (const id of ids) assertSessionId(id)
  if (ids.length === 0) throw new HttpError(400, 'sessionIds 必须是非空数组')
  if (ids.length > MAX_BATCH_SESSIONS) {
    throw new HttpError(400, `单次批量最多 ${MAX_BATCH_SESSIONS} 条，请缩小筛选范围后分批操作`)
  }
  if (action === 'migrate' && typeof request.payload?.workspaceId !== 'string') {
    throw new HttpError(400, '缺少有效的 workspaceId')
  }
  if (action === 'preset' && typeof request.payload?.toPreset !== 'string') {
    throw new HttpError(400, '缺少有效的 toPreset')
  }

  const items: BatchItem[] = []
  const cascaded = new Set<string>()
  for (const id of ids) {
    if (action === 'delete' && cascaded.has(id)) {
      items.push({ sessionId: id, ok: true, cascaded: true })
      continue
    }
    try {
      let outcome: BatchOutcome
      if (action === 'delete') {
        const result = await deleteSessionCascade(ctx, sessionsRoot, id)
        for (const sub of result.deletedSubagents) cascaded.add(sub)
        outcome = result
      } else if (action === 'migrate') {
        outcome = await migrateSession(ctx, sessionsRoot, {
          sessionId: id,
          workspaceId: request.payload!.workspaceId!,
        })
      } else {
        outcome = await migratePreset(ctx, sessionsRoot, {
          sessionId: id,
          toPreset: request.payload!.toPreset!,
        })
      }
      items.push({ sessionId: id, ok: true, result: outcome })
    } catch (error) {
      items.push({ sessionId: id, ok: false, error: errMsg(error) })
    }
  }
  return items
}
