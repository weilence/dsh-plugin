import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { importArchive, previewArchive } from './archive'
import { runBatch } from './batch'
import { deleteSessionCascade } from './delete'
import { migrateSession } from './move'
import { listPresets, migratePreset } from './preset'
import {
  BATCH_PATH,
  DELETE_PATH,
  IMPORT_PATH,
  MAX_ARCHIVE_BYTES,
  MAX_REQUEST_BYTES,
  MIGRATE_PATH,
  PRESET_PATH,
  PRESETS_PATH,
  type BatchRequest,
} from './shared'

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

  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (busy) throw new HttpError(409, '另一个会话存储操作正在进行，请稍后重试')
    busy = true
    try {
      return await operation()
    } finally {
      busy = false
    }
  }

  route(IMPORT_PATH, async (req, res) => {
    const body = await readJsonBody(req, MAX_REQUEST_BYTES)
    if (body.trusted !== true)
      throw new HttpError(400, '请先确认档案来源可信；恢复后的历史权限和指令可能生效')
    const bytes = archiveBytes(body.archive)
    const cwd = requiredText(body.cwd, 'cwd')
    writeJson(
      res,
      200,
      await exclusive(async () => {
        const preview = await previewArchive(ctx, bytes, cwd)
        return { ...(await importArchive(ctx, bytes, cwd, preview.expected)) }
      }),
    )
  })

  route(DELETE_PATH, async (req, res) => {
    const body = await readJsonBody(req)
    const sessionId = requiredText(body.sessionId, 'sessionId')
    writeJson(res, 200, await exclusive(() => deleteSessionCascade(ctx, sessionsRoot, sessionId)))
  })

  route(MIGRATE_PATH, async (req, res) => {
    const body = await readJsonBody(req)
    const sessionId = requiredText(body.sessionId, 'sessionId')
    const workspaceId = requiredText(body.workspaceId, 'workspaceId')
    writeJson(res, 200, await exclusive(() => migrateSession(ctx, sessionsRoot, { sessionId, workspaceId })))
  })

  route(PRESETS_PATH, async (req, res) => {
    writeJson(res, 200, { presets: await listPresets(ctx) })
  })

  route(PRESET_PATH, async (req, res) => {
    const body = await readJsonBody(req)
    const sessionId = requiredText(body.sessionId, 'sessionId')
    const toPreset = requiredText(body.toPreset, 'toPreset')
    writeJson(res, 200, await exclusive(() => migratePreset(ctx, sessionsRoot, { sessionId, toPreset })))
  })

  route(BATCH_PATH, async (req, res) => {
    const body = await readJsonBody(req)
    // 字段类型由 runBatch 逐项校验（action / sessionIds / payload），路由层只透传。
    writeJson(
      res,
      200,
      await exclusive(() =>
        runBatch(ctx, sessionsRoot, {
          action: body.action as BatchRequest['action'],
          sessionIds: body.sessionIds as string[],
          payload: body.payload as BatchRequest['payload'],
        }),
      ),
    )
  })
}
