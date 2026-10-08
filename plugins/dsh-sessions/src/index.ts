import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import {
  deleteSessionFiles,
  describeActivity,
  importArchive,
  migrateSession,
  previewArchive,
} from './archive'
import { DELETE_PATH, IMPORT_PATH, MAX_ARCHIVE_BYTES, MAX_REQUEST_BYTES, MIGRATE_PATH } from './shared'

export const inject = [
  'webServer',
  'connection',
  'sessions',
  'sessionPersistence',
  'attachments',
  'workspaceRegistry',
]

export interface Config {
  /** 会话存储根目录；缺省按官方 dsh-home-paths 解析到 `$DSH_HOME/sessions`。 */
  sessionsRoot?: string
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new HttpError(400, `缺少有效的 ${field}`)
  return value
}

function archiveBytes(value: unknown): Buffer {
  const encoded = requiredText(value, 'archive')
  if (encoded.length > Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4) throw new HttpError(413, '会话档案超过 64 MiB')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) throw new HttpError(400, 'archive 必须是有效的 Base64')
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new HttpError(413, '会话档案超过 64 MiB')
  return bytes
}

type GuardResult = { ok: true } | { ok: false; status: 401 | 403; error: string }

function guard(req: IncomingMessage, ctx: Context): GuardResult {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    return rejection === 401
      ? { ok: false, status: 401, error: '会话管理请求未通过宿主认证' }
      : { ok: false, status: 403, error: '请求来源不允许' }
  }
  return req.method === 'POST' && isTrustedFetch(req) && req.headers['x-dsh-sessions'] === '1'
    ? { ok: true }
    : { ok: false, status: 403, error: '请求来源、方法或协议标记不允许' }
}

export function apply(ctx: Context, config: Config = {}): void {
  if (
    config.sessionsRoot !== undefined &&
    (!config.sessionsRoot || typeof config.sessionsRoot !== 'string')
  ) {
    throw new Error('dsh-sessions.sessionsRoot 必须是会话存储根目录路径')
  }
  // 官方持久化服务没有删除 API；存储根只能显式配置或按官方 home 约定解析。
  const sessionsRoot = resolve(config.sessionsRoot ?? dshHomePath('sessions'))
  let busy = false

  const route = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): void => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler: async (req: IncomingMessage, res: ServerResponse) => {
            const access = guard(req, ctx)
            if (!access.ok) {
              writeJson(res, access.status, { error: access.error })
              return
            }
            try {
              await handler(req, res)
            } catch (error) {
              writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
            }
          },
        }),
      `dsh-sessions: ${path}`,
    )
  }

  route(IMPORT_PATH, async (req, res) => {
    const body = await readJsonBody(req, MAX_REQUEST_BYTES)
    if (body.trusted !== true)
      throw new HttpError(400, '请先确认档案来源可信；恢复后的历史权限和指令可能生效')
    const bytes = archiveBytes(body.archive)
    const cwd = requiredText(body.cwd, 'cwd')
    if (busy) throw new HttpError(409, '另一个会话存储操作正在进行，请稍后重试')
    busy = true
    try {
      const preview = await previewArchive(ctx, bytes, cwd)
      writeJson(res, 200, { ...(await importArchive(ctx, bytes, cwd, preview.expected)) })
    } finally {
      busy = false
    }
  })

  route(DELETE_PATH, async (req, res) => {
    const body = await readJsonBody(req)
    const sessionId = requiredText(body.sessionId, 'sessionId')
    if (busy) throw new HttpError(409, '另一个会话存储操作正在进行，请稍后重试')
    busy = true
    try {
      const id = sessionId as SessionId
      if (!ctx.workspaceRegistry.archivedSessionIds.includes(id)) {
        throw new HttpError(409, '仅允许删除已归档的会话')
      }
      // 「归档时无活动」只是归档那一刻的检查；删除前用官方同一 waterfall 复查，
      // 把删除窗口内本实例的回合、子代理、后台任务与定时任务挡在门外。
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () =>
        Promise.resolve([]),
      )
      if (activity.length > 0) {
        throw new HttpError(409, `会话仍有进行中的活动，已拒绝删除：${describeActivity(activity)}`)
      }
      const filesRemoved = await deleteSessionFiles(ctx, sessionsRoot, id)
      let archiveCleared = false
      let archiveClearError: string | undefined
      try {
        await ctx.workspaceRegistry.unarchiveSession(id)
        archiveCleared = true
      } catch (error) {
        archiveClearError = errMsg(error)
      }
      writeJson(res, 200, { filesRemoved, archiveCleared, ...(archiveClearError && { archiveClearError }) })
    } finally {
      busy = false
    }
  })

  route(MIGRATE_PATH, async (req, res) => {
    const body = await readJsonBody(req)
    const sessionId = requiredText(body.sessionId, 'sessionId')
    const workspaceId = requiredText(body.workspaceId, 'workspaceId')
    if (busy) throw new HttpError(409, '另一个会话存储操作正在进行，请稍后重试')
    busy = true
    try {
      writeJson(res, 200, await migrateSession(ctx, sessionsRoot, { sessionId, workspaceId }))
    } finally {
      busy = false
    }
  })
}
