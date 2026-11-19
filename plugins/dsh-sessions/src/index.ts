import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { migrateSession } from './move'
import { listPresets, migratePreset } from './preset'
import { MIGRATE_PATH, PRESET_PATH, PRESETS_PATH } from './shared'

export const inject = ['webServer', 'connection', 'sessions', 'sessionPersistence', 'workspaceRegistry']

export interface Config {
  /** 会话存储根目录；缺省按官方 dsh-home-paths 解析到 `$DSH_HOME/sessions`。 */
  sessionsRoot?: string
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new HttpError(400, `缺少有效的 ${field}`)
  return value
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
  // 官方持久化服务不暴露磁盘手术入口；存储根只能显式配置或按官方 home 约定解析。
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
}
