// dsh-models host half：固定来源的 models.dev 原始目录镜像 + 只读生效能力桥。
//
// 两条同源路由：
//   GET /dsh-models/catalog
//     models.dev 原始 JSON（ETag 感知，Host 不解释业务字段）。
//   GET /dsh-models/effective-models?provider=<route>
//     某个 route 当前真正生效的模型能力，来自 ctx.llm.resolveModelInfo
//     （会话模型选择器看到的同一份事实）。只读，不写 settings。

import type { Context } from '@deepseek-ai/cordis'
import type { } from '@deepseek-ai/dsh-host-webserver'
import type { } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { effectiveModelsFor, writeEffectiveJson } from './effective'
import { CatalogMirror } from './mirror'

export const inject: string[] = ['webServer']
export const CATALOG_PATH = '/dsh-models/catalog'
export const EFFECTIVE_PATH = '/dsh-models/effective-models'

function errMsg(error: unknown) {
	const message = (error as { message?: string } | null | undefined)?.message
	return message || String(error)
}

/**
 * Whether a hostname names the loopback interface in any of its spellings.
 * `URL.hostname` keeps an IPv6 literal's brackets, and the whole 127/8 block
 * is loopback, so both are handled rather than only the canonical `127.0.0.1`.
 */
function isLoopbackHostname(hostname: string) {
	const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
	return (
		bare === 'localhost' || bare === '::1' || bare === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(bare)
	)
}

/**
 * Whether a request's Host header addresses the web server's own listen host.
 *
 * A loopback bind answers to several spellings (`localhost`, `127.0.0.1`,
 * `::1`), so those are treated as one address — but only when the server itself
 * listens on loopback. A non-loopback Host header never passes, which is what
 * keeps this same-origin bridge from serving a DNS-rebinding page.
 */
export function isExpectedHost(req: IncomingMessage, expectedHost: string) {
	const authority = req.headers.host
	if (!authority || /[\/@?#]/.test(authority)) return false
	try {
		const actual = new URL(`http://${authority}`).hostname
		if (actual === expectedHost) return true
		return isLoopbackHostname(expectedHost) && isLoopbackHostname(actual)
	} catch {
		return false
	}
}

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

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
	const payload = Buffer.from(JSON.stringify(body))
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': String(payload.byteLength),
		'cache-control': 'no-store',
	})
	res.end(payload)
}

/** 只读请求的统一前置检查：来源 host、方法、provider 参数。 */
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

	// 只读能力桥是可选面：llm 服务缺席时（例如最小化组合）目录桥照常工作，
	// 面板把「生效能力」显示为未知，而不是让整个插件不激活。
	ctx.inject(['llm'], (llmCtx) =>
		llmCtx.effect(
			() =>
				llmCtx.webServer.register({
					kind: 'exact',
					path: EFFECTIVE_PATH,
					handler: async (req, res) => {
						if (!isExpectedHost(req, llmCtx.webServer.host)) {
							writeEffectiveJson(res, 403, { error: 'forbidden' })
							return
						}
						if (req.method !== 'GET') {
							res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
							res.end()
							return
						}
						const provider = readEffectiveProvider(req)
						if (provider === undefined) {
							writeEffectiveJson(res, 400, { error: '缺少 provider 查询参数' })
							return
						}
						try {
							const outcome = await effectiveModelsFor(llmCtx, provider)
							if (outcome.kind === 'unavailable') {
								writeEffectiveJson(res, 404, { error: outcome.message })
								return
							}
							writeEffectiveJson(res, 200, { models: outcome.models })
						} catch (error) {
							writeEffectiveJson(res, 500, { error: errMsg(error) })
						}
					},
				}),
			'dsh-models: effective-models bridge',
		),
	)
}

export { apply }
