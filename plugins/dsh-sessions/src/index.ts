import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-query'
import { sessionLogZipFilename } from '@deepseek-ai/dsh-session-log-export'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import type {} from '@dsh-plugins/shared/remote'
import { exportArchive, importArchive, previewArchive } from './archive'
import {
  EXPORT_PATH,
  IMPORT_PATH,
  LIST_PATH,
  MAX_ARCHIVE_BYTES,
  MAX_REQUEST_BYTES,
  PREVIEW_PATH,
  REMOTES_PATH,
  TRANSFER_PATH,
  type ArchiveExpected,
  type SessionListItem,
} from './shared'

export const inject = [
  'webServer',
  'connection',
  'sessions',
  'sessionPersistence',
  'sessionQuery',
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

function expectedValue(value: unknown): ArchiveExpected {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '缺少导入预览版本，请重新预览')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.archiveDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.archiveDigest) ||
    typeof record.cwd !== 'string' ||
    record.sessions === null ||
    typeof record.sessions !== 'object' ||
    Array.isArray(record.sessions) ||
    !Object.values(record.sessions).every(
      (digest) => digest === null || (typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)),
    )
  )
    throw new HttpError(400, '导入预览版本无效，请重新预览')
  return record as unknown as ArchiveExpected
}

function requireTrust(body: Record<string, unknown>): void {
  if (body.trusted !== true) throw new HttpError(400, '请先确认档案来源可信；恢复后的历史权限和指令可能生效')
}

export function apply(ctx: Context): void {
  let importing = false
  const route = (
    path: string,
    method: 'GET' | 'POST',
    operation: (body: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): void => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler: async (req: IncomingMessage, res: ServerResponse) => {
            const rejection = ctx.connection.requestRejection(req)
            if (rejection !== undefined) {
              writeJson(res, rejection, {
                error: rejection === 401 ? '会话迁移请求未通过宿主认证' : '请求来源不允许',
              })
              return
            }
            if (
              req.method !== method ||
              !isTrustedFetch(req) ||
              (method === 'POST' && req.headers['x-dsh-sessions'] !== '1')
            ) {
              writeJson(res, 403, { error: '请求来源、方法或协议标记不允许' })
              return
            }
            try {
              const body = method === 'POST' ? await readJsonBody(req, MAX_REQUEST_BYTES) : {}
              writeJson(res, 200, await operation(body))
            } catch (error) {
              writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
            }
          },
        }),
      `dsh-sessions: ${path}`,
    )
  }

  route(LIST_PATH, 'GET', async () => {
    const records = (await ctx.sessionQuery.listSessions()).filter(
      ({ header }) => header.origin !== 'subagent',
    )
    const titles = await ctx.sessionQuery.readTitleSnapshots(records.map(({ header }) => header.id))
    const byId = new Map(titles.map((result) => [result.sessionId, result]))
    const sessions: SessionListItem[] = records.map(({ header, live }) => {
      const result = byId.get(header.id)
      return {
        id: header.id,
        ...(result?.status === 'fulfilled' && result.value.title !== undefined
          ? { title: result.value.title.title }
          : {}),
        ...(result?.status === 'rejected' ? { titleError: errMsg(result.reason) } : {}),
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        live,
      }
    })
    return { sessions }
  })

  route(EXPORT_PATH, 'POST', async (body) => {
    const id = requiredText(body.id, 'id')
    if (id.length > 4096) throw new HttpError(400, '会话 ID 过长')
    const bytes = await exportArchive(ctx, id)
    return { archive: Buffer.from(bytes).toString('base64'), filename: sessionLogZipFilename(id) }
  })

  route(PREVIEW_PATH, 'POST', async (body) => {
    const preview = await previewArchive(ctx, archiveBytes(body.archive), requiredText(body.cwd, 'cwd'))
    return { ...preview }
  })

  route(IMPORT_PATH, 'POST', async (body) => {
    requireTrust(body)
    const bytes = archiveBytes(body.archive)
    const cwd = requiredText(body.cwd, 'cwd')
    const expected = expectedValue(body.expected)
    if (importing) throw new HttpError(409, '另一份会话档案正在导入，请稍后重新预览')
    importing = true
    try {
      return { ...(await importArchive(ctx, bytes, cwd, expected)) }
    } finally {
      importing = false
    }
  })

  route(REMOTES_PATH, 'GET', async () => {
    const transport = ctx.get('remoteTransport')
    return { available: transport !== undefined, connections: transport?.listConnections() ?? [] }
  })

  route(TRANSFER_PATH, 'POST', async (body) => {
    const transport = ctx.get('remoteTransport')
    if (transport === undefined)
      throw new HttpError(503, '本机未启用提供会话传输通道的 dsh-remote，请安装或更新并连接远端')
    const id = requiredText(body.remoteId, 'remoteId')
    const cwd = requiredText(body.cwd, 'cwd')
    archiveBytes(body.archive)
    if (body.action !== 'preview' && body.action !== 'import') throw new HttpError(400, '无效的传输动作')
    const request: Record<string, unknown> = { archive: body.archive, cwd }
    if (body.action === 'import') {
      requireTrust(body)
      request.expected = expectedValue(body.expected)
      request.trusted = true
    }
    const result = await transport.request(
      id,
      body.action === 'preview' ? PREVIEW_PATH : IMPORT_PATH,
      request,
    )
    if (result === null || typeof result !== 'object' || Array.isArray(result))
      throw new HttpError(502, '远端返回了非对象响应')
    return result as Record<string, unknown>
  })
}
