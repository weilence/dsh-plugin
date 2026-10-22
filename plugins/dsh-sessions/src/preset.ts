import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HttpError } from '@dsh-plugins/shared/http'
import { assertNotLoaded, acquireWriteLock, releaseLock } from './guards'
import {
  assertSessionDirectory,
  assertSessionId,
  encodeArtifactBytes,
  locateSessionArtifact,
  readSessionArtifactFile,
  replaceSessionFile,
} from './surgery'

/** 预设迁移：改写最后一条 `agent-preset/selected` 事件（无则改日志头），消息历史不动。 */

export interface PresetResult {
  migrated: boolean
  oldPreset?: string
  newPreset: string
}

/** 官方预设服务的最小结构面；宿主未挂载该服务时功能整体禁用。 */
interface AgentPresets {
  list(): Promise<ReadonlyArray<{ id: string }>>
}

function presetService(ctx: Context): AgentPresets {
  const presets = ctx.get('agentPresets') as unknown
  if (presets === undefined || typeof (presets as AgentPresets).list !== 'function') {
    throw new HttpError(503, '宿主未提供 Agent 预设服务，无法迁移预设')
  }
  return presets as AgentPresets
}

/** 宿主侧可选项清单：全部已注册预设 id，供客户端下拉选择。 */
export async function listPresets(ctx: Context): Promise<string[]> {
  const roster = await presetService(ctx).list()
  return [
    ...new Set(
      (roster ?? []).map((preset) => preset?.id).filter((id): id is string => typeof id === 'string'),
    ),
  ]
}

export async function migratePreset(
  ctx: Context,
  sessionsRoot: string,
  input: { sessionId: string; toPreset: string },
): Promise<PresetResult> {
  const id = assertSessionId(input.sessionId)
  const toPreset = input.toPreset.trim()
  if (toPreset === '') throw new HttpError(400, '缺少有效的 toPreset')
  if (!(await presetService(ctx).list()).some((preset) => preset.id === toPreset)) {
    throw new HttpError(400, `Agent 预设「${toPreset}」不存在`)
  }
  const stat = await ctx.sessionPersistence.stat(id)
  if (stat === undefined) throw new HttpError(409, '会话没有已存储的日志，无法迁移预设')
  if (stat.formatStatus === 'migration-required') {
    throw new HttpError(409, '会话日志是旧代格式，请先在宿主中打开该会话完成格式升级后重试')
  }
  assertNotLoaded(ctx, id)

  const handle = await acquireWriteLock(ctx, id)
  try {
    const artifact = await locateSessionArtifact(sessionsRoot, id)
    await assertSessionDirectory(sessionsRoot, artifact.dir, id)
    const path = join(artifact.dir, artifact.filename)
    const content = await readSessionArtifactFile(path, artifact.zstd)
    if (content.header.id !== id) throw new HttpError(409, '会话工件头行 id 与请求不符，拒绝迁移预设')

    let selectedIndex = -1
    let selectedPreset: string | undefined
    if (content.bodyText !== '') {
      const lines = content.bodyText.slice(0, -1).split('\n')
      for (const [index, line] of lines.entries()) {
        let event: { type?: unknown; data?: { agentPreset?: unknown } }
        try {
          event = JSON.parse(line) as typeof event
        } catch {
          continue
        }
        if (event.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
          selectedIndex = index
          selectedPreset = event.data.agentPreset
        }
      }
    }
    const headerPreset =
      typeof content.header.agentPreset === 'string' ? (content.header.agentPreset as string) : undefined
    const oldPreset = selectedIndex >= 0 ? selectedPreset : headerPreset
    if (oldPreset === toPreset) {
      return { migrated: false, ...(oldPreset !== undefined && { oldPreset }), newPreset: toPreset }
    }

    let headerText = content.headerText
    let bodyText = content.bodyText
    if (selectedIndex >= 0) {
      const lines = content.bodyText.slice(0, -1).split('\n')
      const event = JSON.parse(lines[selectedIndex]!) as { data: Record<string, unknown> }
      lines[selectedIndex] = JSON.stringify({ ...event, data: { ...event.data, agentPreset: toPreset } })
      bodyText = `${lines.join('\n')}\n`
    } else {
      headerText = JSON.stringify({ ...content.header, agentPreset: toPreset })
    }
    const bytes = await encodeArtifactBytes(headerText, bodyText, artifact.zstd)
    const published = await replaceSessionFile(path, bytes)
    if (published.backupPath !== undefined) {
      ctx.logger.warn(`dsh-sessions: 预设迁移后备份未能删除，原文件保留在 ${published.backupPath}`)
    }
    ctx.logger.info(`dsh-sessions: session "${id}" preset migrated to "${toPreset}"`)
    return { migrated: true, ...(oldPreset !== undefined && { oldPreset }), newPreset: toPreset }
  } finally {
    await releaseLock(handle)
  }
}
