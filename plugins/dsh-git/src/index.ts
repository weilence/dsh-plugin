import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { readCommitFiles, readGitLog } from './log'
import { scanGitRepositories } from './scan'
import { DEFAULT_LOG_LIMIT, FILES_PATH, GIT_HEADER, LOG_PATH, MAX_LOG_LIMIT, REPOS_PATH } from './shared'

export const inject = ['webServer', 'connection']

type GuardResult = { ok: true } | { ok: false; status: 401 | 403; error: string }

function guard(req: IncomingMessage, ctx: Context): GuardResult {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    return rejection === 401
      ? { ok: false, status: 401, error: 'Git 插件请求未通过宿主认证' }
      : { ok: false, status: 403, error: '请求来源不允许' }
  }
  return req.method === 'POST' && isTrustedFetch(req) && req.headers[GIT_HEADER] === '1'
    ? { ok: true }
    : { ok: false, status: 403, error: '请求来源、方法或协议标记不允许' }
}

async function existingDirectory(value: unknown, field: string): Promise<string> {
  if (typeof value !== 'string' || value.trim().length === 0) throw new HttpError(400, `缺少有效的 ${field}`)
  const dir = resolve(value)
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) throw new HttpError(400, `${field} 必须是目录`)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, `目录不可访问：${errMsg(error)}`)
  }
  return dir
}

function logLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LOG_LIMIT
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LOG_LIMIT)
    throw new HttpError(400, `limit 必须是 1 到 ${MAX_LOG_LIMIT} 的整数`)
  return value
}

export function apply(ctx: Context): void {
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
      `dsh-git: ${path}`,
    )
  }

  route(REPOS_PATH, async (req, res) => {
    const body = await readJsonBody(req)
    const dir = await existingDirectory(body.cwd, 'cwd')
    writeJson(res, 200, await scanGitRepositories(dir))
  })

  route(LOG_PATH, async (req, res) => {
    const body = await readJsonBody(req)
    const repo = await existingDirectory(body.repo, 'repo')
    writeJson(res, 200, await readGitLog(repo, logLimit(body.limit)))
  })

  route(FILES_PATH, async (req, res) => {
    const body = await readJsonBody(req)
    const repo = await existingDirectory(body.repo, 'repo')
    if (typeof body.hash !== 'string' || !/^[0-9a-f]{4,40}$/i.test(body.hash))
      throw new HttpError(400, '缺少有效的 hash')
    writeJson(res, 200, await readCommitFiles(repo, body.hash))
  })
}
