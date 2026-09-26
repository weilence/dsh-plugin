import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { IncomingMessage } from 'node:http'
import { errMsg } from '@dsh-plugins/shared'
import { isExpectedHost, writeJson } from '@dsh-plugins/shared/http'
import { effectiveModelsFor } from './effective'
import { CatalogMirror } from './mirror'

export const inject: string[] = ['webServer']
export const CATALOG_PATH = '/dsh-models/catalog'
export const EFFECTIVE_PATH = '/dsh-models/effective-models'

export function etagMatches(header: string | string[] | undefined, etag: string) {
  const raw = Array.isArray(header) ? header.join(',') : header
  if (!raw) return false
  return raw.split(',').some((part) => {
    const candidate = part.trim()
    return (
      candidate === '*' || candidate === etag || candidate.replace(/^W\//, '') === etag.replace(/^W\//, '')
    )
  })
}

export function readEffectiveProvider(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const provider = url.searchParams.get('provider')?.trim()
  return provider ? provider : undefined
}

function apply(ctx: Context) {
  const mirror = new CatalogMirror({
    cacheDir: dshHomePath('cache', 'dsh-models'),
    onInfo: (message) => ctx.logger?.info?.(`dsh-models: ${message}`),
    onWarn: (message) => ctx.logger?.warn?.(`dsh-models: ${message}`),
  })

  void mirror.loadPersisted().finally(() => mirror.start())
  ctx.effect(() => () => mirror.stop(), 'dsh-models: stop models.dev catalog mirror')

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: CATALOG_PATH,
        handler: async (req, res) => {
          if (!isExpectedHost(req, ctx.webServer.host)) {
            writeJson(res, 403, { error: 'forbidden' })
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
            res.end()
            return
          }
          try {
            const snapshot = mirror.snapshot()
            if (!snapshot.body || !snapshot.etag) {
              writeJson(res, 503, {
                error: 'models.dev 目录尚未就绪',
                detail: snapshot.lastError ?? undefined,
              })
              return
            }
            const commonHeaders: Record<string, string> = {
              etag: snapshot.etag,
              'cache-control': 'private, max-age=0, must-revalidate',
              'x-dsh-models-checked-at': String(snapshot.checkedAt ?? ''),
              'x-dsh-models-updated-at': String(snapshot.updatedAt ?? ''),
            }
            if (etagMatches(req.headers['if-none-match'], snapshot.etag)) {
              res.writeHead(304, commonHeaders)
              res.end()
              return
            }
            res.writeHead(200, {
              ...commonHeaders,
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(snapshot.body.byteLength),
            })
            if (req.method === 'HEAD') res.end()
            else res.end(snapshot.body)
          } catch (error) {
            writeJson(res, 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-models: catalog bridge',
  )

  // 只读能力桥是可选面：llm 服务缺席时目录桥照常工作，面板把「生效能力」
  // 显示为未知，而不是让整个插件不激活。
  ctx.inject(['llm'], (llmCtx) =>
    llmCtx.effect(
      () =>
        llmCtx.webServer.register({
          kind: 'exact',
          path: EFFECTIVE_PATH,
          handler: async (req, res) => {
            if (!isExpectedHost(req, llmCtx.webServer.host)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            if (req.method !== 'GET') {
              res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
              res.end()
              return
            }
            const provider = readEffectiveProvider(req)
            if (provider === undefined) {
              writeJson(res, 400, { error: '缺少 provider 查询参数' })
              return
            }
            try {
              const outcome = await effectiveModelsFor(llmCtx, provider)
              if (outcome.kind === 'unavailable') {
                writeJson(res, 404, { error: outcome.message })
                return
              }
              writeJson(res, 200, { models: outcome.models })
            } catch (error) {
              writeJson(res, 500, { error: errMsg(error) })
            }
          },
        }),
      'dsh-models: effective-models bridge',
    ),
  )
}

export { apply }
