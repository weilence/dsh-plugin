import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { FILE_PATH, SAVE_PATH, type PromptFile } from './shared'

export const inject: string[] = ['webServer', 'systemPrompt']

const MAX_PROMPT_BYTES = 1024 * 1024

/** 用户系统提示词正文的文件名；独立于 AGENTS.md，不进入 dsh-agent-instructions 的指令链。 */
const PROMPT_FILE_NAME = 'system-prompt.md'

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
  throw new HttpError(400, '缺少有效的文件版本，请重新打开设置页')
}

function checkRevision(actual: PromptFile, expected: string | null): void {
  if (actual.revision !== expected) {
    throw new HttpError(409, '系统提示词已在其他位置修改，请重新打开设置页后再编辑')
  }
}

export interface Config {
  dshHome?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.dshHome !== undefined && (typeof config.dshHome !== 'string' || !config.dshHome.trim())) {
    throw new Error('dsh-prompts.dshHome 必须是非空目录路径')
  }
  const path = join(resolveDshHome(config.dshHome), PROMPT_FILE_NAME)
  let writing = Promise.resolve()
  const serialize = async (operation: () => Promise<void>): Promise<void> => {
    const next = writing.then(operation)
    writing = next.catch(() => {})
    await next
  }

  // 段文本在每次组装时同步重读：面板保存与外部编辑都在下一个模型步骤生效。
  // 任何读取异常都以空串兜底——段文本求值抛错会让整个组装失败，不能让
  // 一个坏文件拖垮宿主的全部请求；同一错误只警告一次，避免日志刷屏。
  let warned: string | null = null
  const warnOnce = (message: string): void => {
    if (warned === message) return
    warned = message
    ctx.logger.warn('dsh-prompts 系统提示词段已忽略：%s', message)
  }
  const sectionText = (): string => {
    let info
    try {
      info = lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        warned = null
        return ''
      }
      warnOnce(errMsg(error))
      return ''
    }
    if (!info.isFile() || info.size > MAX_PROMPT_BYTES) {
      warnOnce(`${path} 不是普通文件或超过 1 MiB`)
      return ''
    }
    try {
      const content = readFileSync(path, 'utf8')
      if (Buffer.byteLength(content) > MAX_PROMPT_BYTES) {
        warnOnce(`${path} 不是普通文件或超过 1 MiB`)
        return ''
      }
      warned = null
      return content
    } catch (error) {
      warnOnce(errMsg(error))
      return ''
    }
  }

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'user:system-prompt',
        // 位于第一方末尾（部署 persona 后缀 10200）之后：用户段变化只影响
        // 提示词尾部，前缀 KV 缓存尽量保留。
        order: 10500,
        text: sectionText,
        // 用户自由文本原样保留：{{…}} 不做变量插值，未知引用会让组装失败。
        interpolate: false,
      }),
    'dsh-prompts: system prompt section',
  )

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
            throw new HttpError(409, '系统提示词已在其他位置创建，请重新打开设置页后再编辑')
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
}
