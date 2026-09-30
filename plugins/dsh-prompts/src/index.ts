import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { DELETE_PATH, FILE_PATH, SAVE_PATH, type PromptFile } from './shared'

export const inject: string[] = ['webServer']

const MAX_PROMPT_BYTES = 1024 * 1024

function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function readPrompt(path: string): Promise<PromptFile> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, content: '', revision: null }
    }
    throw error
  }
  if (!info.isFile()) throw new HttpError(400, `${path} 不是普通文件，不能通过此面板编辑`)
  if (info.size > MAX_PROMPT_BYTES) throw new HttpError(413, `${path} 超过 1 MiB，不能通过此面板编辑`)
  const content = await readFile(path, 'utf8')
  if (Buffer.byteLength(content) > MAX_PROMPT_BYTES) {
    throw new HttpError(413, `${path} 超过 1 MiB，不能通过此面板编辑`)
  }
  return { path, exists: true, content, revision: revision(content) }
}

function requireRevision(value: unknown): string | null {
  if (value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) return value
  throw new HttpError(400, '缺少有效的文件版本，请先刷新')
}

function checkRevision(actual: PromptFile, expected: string | null): void {
  if (actual.revision !== expected) throw new HttpError(409, '全局提示词已在其他位置修改，请刷新后再编辑')
}

export interface Config {
  dshHome?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.dshHome !== undefined && (typeof config.dshHome !== 'string' || !config.dshHome.trim())) {
    throw new Error('dsh-prompts.dshHome 必须是非空目录路径')
  }
  // agent-instructions 未暴露其私有 dshHome 覆盖；两插件有覆盖时需显式配置相同目录。
  const path = join(resolveDshHome(config.dshHome), 'AGENTS.md')
  let writing = Promise.resolve()
  const serialize = async (operation: () => Promise<void>): Promise<void> => {
    const next = writing.then(operation)
    writing = next.catch(() => {})
    await next
  }

  const route = (
    endpoint: string,
    method: 'GET' | 'POST',
    operation: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): void => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: endpoint,
          handler: async (req: IncomingMessage, res: ServerResponse) => {
            if (
              !isExpectedHost(req, ctx.webServer.host) ||
              req.method !== method ||
              (method === 'POST' && (!isTrustedFetch(req) || req.headers['x-dsh-prompts'] !== '1'))
            ) {
              writeJson(res, 403, { error: '请求来源或方法不允许' })
              return
            }
            try {
              await operation(req, res)
            } catch (error) {
              writeJson(res, error instanceof HttpError ? error.status : 500, { error: errMsg(error) })
            }
          },
        }),
      `dsh-prompts: ${endpoint}`,
    )
  }

  route(FILE_PATH, 'GET', async (_req, res) => {
    writeJson(res, 200, { ...(await readPrompt(path)) })
  })

  route(SAVE_PATH, 'POST', async (req, res) => {
    const body = await readJsonBody(req)
    const expected = requireRevision(body.revision)
    if (typeof body.content !== 'string') throw new HttpError(400, '提示词内容必须是文本')
    const content = body.content
    if (Buffer.byteLength(content) > MAX_PROMPT_BYTES) throw new HttpError(413, '提示词超过 1 MiB')
    await serialize(async () => {
      const current = await readPrompt(path)
      checkRevision(current, expected)
      await mkdir(dirname(path), { recursive: true })
      if (!current.exists) {
        try {
          await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new HttpError(409, '全局提示词已在其他位置创建，请刷新后再编辑')
          }
          throw error
        }
      } else {
        // 同目录临时文件 + rename，避免读者在写入过程中看到半截提示词。
        const temp = join(dirname(path), `.AGENTS.md.${randomUUID()}.tmp`)
        try {
          const mode = (await lstat(path)).mode & 0o777
          await writeFile(temp, content, { encoding: 'utf8', flag: 'wx', mode })
          await rename(temp, path)
        } finally {
          try {
            await unlink(temp)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
      writeJson(res, 200, { ...(await readPrompt(path)) })
    })
  })

  route(DELETE_PATH, 'POST', async (req, res) => {
    const body = await readJsonBody(req)
    const expected = requireRevision(body.revision)
    await serialize(async () => {
      const current = await readPrompt(path)
      checkRevision(current, expected)
      if (!current.exists) throw new HttpError(409, '全局提示词已不存在，请刷新')
      await unlink(path)
      writeJson(res, 200, { path, exists: false, content: '', revision: null })
    })
  })
}
