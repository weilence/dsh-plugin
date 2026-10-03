import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { importArchive, previewArchive } from './archive'
import { IMPORT_PATH, MAX_ARCHIVE_BYTES, MAX_REQUEST_BYTES } from './shared'

export const inject = [
  'webServer',
  'connection',
  'sessions',
  'sessionPersistence',
  'attachments',
  'workspaceRegistry',
]

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

export function apply(ctx: Context): void {
  let importing = false
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: IMPORT_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const rejection = ctx.connection.requestRejection(req)
          if (rejection !== undefined) {
            writeJson(res, rejection, {
              error: rejection === 401 ? '会话导入请求未通过宿主认证' : '请求来源不允许',
            })
            return
          }
          if (req.method !== 'POST' || !isTrustedFetch(req) || req.headers['x-dsh-sessions'] !== '1') {
            writeJson(res, 403, { error: '请求来源、方法或协议标记不允许' })
            return
          }
          try {
            const body = await readJsonBody(req, MAX_REQUEST_BYTES)
            if (body.trusted !== true)
              throw new HttpError(400, '请先确认档案来源可信；恢复后的历史权限和指令可能生效')
            const bytes = archiveBytes(body.archive)
            const cwd = requiredText(body.cwd, 'cwd')
            if (importing) throw new HttpError(409, '另一份会话档案正在导入，请稍后重试')
            importing = true
            try {
              const preview = await previewArchive(ctx, bytes, cwd)
              writeJson(res, 200, { ...(await importArchive(ctx, bytes, cwd, preview.expected)) })
            } finally {
              importing = false
            }
          } catch (error) {
            writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
          }
        },
      }),
    `dsh-sessions: ${IMPORT_PATH}`,
  )
}
