import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only：ctx.webServer 的 Context 声明合并（host-webserver 契约类型）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { WebError } from '@deepseek-ai/dsh-web'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import {
  emptyPatchDoc,
  parsePatchDoc,
  renderPatchDoc,
  writeTextAtomic,
  type Document,
} from '@dsh-plugins/shared/patch'
import { createZhipuSearchProvider } from './search'
import { hasCliPatchArg, lookupLiveWeb, providerOf } from './live'
import { appendManagedRow, disableInRow, enableInRow, scanWebRows, type WebRow } from './switchPatch'
import {
  SWITCH_SET_PATH,
  SWITCH_STATE_PATH,
  ZHIPU_PROVIDER,
  type SearchSwitchSetRequest,
  type SearchSwitchSetResponse,
  type SearchSwitchView,
} from './shared'

export const inject: string[] = ['credentials', 'tools', 'web', 'webServer']

// serverName → 模型侧工具名 mcp__<serverName>__<rawName>；
// 须匹配 in-box 的 /^[A-Za-z0-9_-]{1,32}$/ 且全局唯一。
interface McpServerSpec {
  serverName: string
  url: string
  callTimeoutMs: number
}

// 搜索 MCP 与 WebSearchProvider 并存：前者向模型暴露 search_query 之外的
// 域过滤、时效等参数，后者只承接官方 web_search 的简化入参。
const MCP_SERVERS: readonly McpServerSpec[] = [
  {
    serverName: 'zhipu_search',
    url: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
    callTimeoutMs: 30_000,
  },
  {
    serverName: 'zhipu_reader',
    url: 'https://open.bigmodel.cn/api/mcp/web_reader/mcp',
    callTimeoutMs: 60_000,
  },
]

// 只取挂载所需的三个导出；整个命名空间传给 ctx.plugin 可能把 Config 误当配置 schema。
const MCP_CLIENT_PLUGIN = {
  name: mcpClient.name,
  inject: mcpClient.inject,
  apply: mcpClient.apply,
}

// 两个候选名是编译期常量、满足 POSIX 标识符规则，直接断言（用官方
// credentialRef() 构造需把 in-box 包拉进运行时 bundle，不值得）。
const KEY_REFS = ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'] as const

export async function apply(ctx: Context) {
  // 缺席才尝试次选；首选解析失败时继续搜索会悄然切换账户和计费凭据。
  async function resolveKey(): Promise<{ key: string | null; failure: string | undefined }> {
    for (const name of KEY_REFS) {
      try {
        const resolved = await ctx.credentials.resolve(name as CredentialRef)
        if (resolved) return { key: resolved.value, failure: undefined }
      } catch (error) {
        return { key: null, failure: `凭证解析失败（${name}: ${errMsg(error)}）` }
      }
    }
    return { key: null, failure: undefined }
  }

  ctx.web.registerSearchProvider(
    createZhipuSearchProvider(async () => {
      const { key, failure } = await resolveKey()
      if (failure) throw new WebError(failure, 'WEB_PROVIDER_ERROR')
      if (!key) {
        throw new WebError('未配置智谱 Coding Plan API Key（ZAI_CODING_CN_API_KEY）', 'WEB_PROVIDER_ERROR')
      }
      return key
    }),
  )

  const { key: apiKey, failure } = await resolveKey()
  if (failure !== undefined) {
    ctx.logger.error(`dsh-zhipu-tools: ${failure}，智谱能力保持不可用`)
  } else if (apiKey === null) {
    ctx.logger.error('dsh-zhipu-tools: 未配置 zai-coding-cn 供应商，智谱能力保持不可用')
  }

  // 重连与工具同步由 in-box mcp-client 承担；单个服务器失败只记日志、不
  // 阻塞插件激活，也不影响已注册的搜索提供者。
  if (apiKey) {
    for (const server of MCP_SERVERS) {
      try {
        const config: StreamableHttpConfig = {
          transport: 'streamable-http',
          serverName: server.serverName,
          url: server.url,
          headers: { Authorization: `Bearer ${apiKey}` },
          toolCallTimeoutMs: server.callTimeoutMs,
          failOnStartupError: false,
        }
        await ctx.plugin(MCP_CLIENT_PLUGIN, config)
        ctx.logger.info(`dsh-zhipu-tools: MCP ${server.serverName} 已挂载（in-box mcp-client）`)
      } catch (error) {
        ctx.logger.error(
          `dsh-zhipu-tools: MCP ${server.serverName} 挂载失败（仅该服务器工具不可用）: ${errMsg(error)}`,
        )
      }
    }
  }

  registerSearchSwitchRoutes(ctx)
}

// ---- 搜索替换开关：读写两层用户 patch 的 web 行，读态以运行时为准 ----

interface ProfileContextLike {
  name?: unknown
  patchPath?: unknown
  home?: unknown
}

interface SwitchLayer {
  scope: 'profile' | 'home'
  file: string
  doc: Document
}

function profileContextOf(ctx: Context): { patchPath: string; home: string } | undefined {
  const profile = ctx.get('profileContext') as ProfileContextLike | undefined
  if (profile === undefined || typeof profile.patchPath !== 'string' || typeof profile.home !== 'string') {
    return undefined
  }
  return { patchPath: profile.patchPath, home: profile.home }
}

async function readPatchText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function loadSwitchLayers(profile: { patchPath: string; home: string }): Promise<SwitchLayer[]> {
  const files: { scope: 'profile' | 'home'; file: string }[] = [
    { scope: 'profile', file: profile.patchPath },
    { scope: 'home', file: join(profile.home, 'cordis.patch.yml') },
  ]
  const layers: SwitchLayer[] = []
  for (const { scope, file } of files) {
    const text = await readPatchText(file)
    try {
      layers.push({ scope, file, doc: text === null ? emptyPatchDoc() : parsePatchDoc(text) })
    } catch (error) {
      throw new HttpError(500, `${file} 解析失败：${errMsg(error)}`)
    }
  }
  return layers
}

/** 两层文件的 web 行折叠：profile 行在前、home 行在后，后行覆盖前行。 */
function foldWebRows(layers: readonly SwitchLayer[]): { layer: SwitchLayer; row: WebRow } | undefined {
  let folded: { layer: SwitchLayer; row: WebRow } | undefined
  for (const layer of layers) {
    for (const row of scanWebRows(layer.doc)) folded = { layer, row }
  }
  return folded
}

/** 开关视图：读态以运行时实际生效值为准，可编辑性按生效来源层判定。 */
export function switchViewOf(
  ctx: Context,
  layers: readonly SwitchLayer[],
  cliPatch = hasCliPatchArg(),
): SearchSwitchView {
  const folded = foldWebRows(layers)
  const fileProvider =
    folded === undefined
      ? null
      : typeof folded.row.config?.searchProvider === 'string'
        ? (folded.row.config.searchProvider as string)
        : null
  const lookup = lookupLiveWeb(
    ctx.get('loader') as Parameters<typeof lookupLiveWeb>[0],
    folded !== undefined,
    cliPatch,
  )
  const effectiveProvider =
    lookup.introspectable && lookup.entry.origin !== 'missing' ? providerOf(lookup.entry) : undefined
  const active = (effectiveProvider ?? fileProvider) === ZHIPU_PROVIDER

  // 可编辑性 = 生效来源能否被两层用户文件覆盖：bundle 可被 home 覆盖、
  // file 就是用户文件本身；--patch 优先级最高且不落盘，只能改启动参数；
  // missing 意味着 web 服务未加载，写谁都不生效。
  let editable = true
  let reason: string | null = null
  if (lookup.introspectable) {
    if (lookup.entry.origin === 'missing') {
      editable = false
      reason = 'web 服务未在当前组合中加载（行缺失或被停用），开关无法生效'
    } else if (lookup.entry.disabled) {
      // 行级停用不是本开关管辖的范围：先恢复启用才谈得上切换提供者。
      editable = false
      reason = 'web 配置行被停用（disabled），请先在 patch 中恢复其启用'
    } else if (lookup.entry.origin === 'cli') {
      editable = false
      reason = 'web 配置由启动参数 --patch 指定，优先级高于用户 patch 文件；请在启动参数中调整'
    }
  }

  return {
    effectiveProvider: effectiveProvider ?? undefined,
    active,
    fileProvider,
    editable,
    reason,
    hotApply: ctx.get('hmr') !== undefined,
    patchPaths: { profile: layers[0].file, home: layers[1].file },
    writeTarget: folded === undefined ? 'create:home' : `in-place:${folded.layer.scope}`,
  }
}

function registerSearchSwitchRoutes(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SWITCH_STATE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'GET') {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const profile = profileContextOf(ctx)
            if (profile === undefined) {
              writeJson(res, 503, {
                error: '当前宿主未提供 profileContext（非 profile 启动），无法定位 patch 层',
              })
              return
            }
            const layers = await loadSwitchLayers(profile)
            writeJson(res, 200, switchViewOf(ctx, layers) as unknown as Record<string, unknown>)
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: errMsg(error) })
          }
        },
      }),
    'dsh-zhipu-tools: search-switch state',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SWITCH_SET_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = (await readJsonBody(req)) as unknown as SearchSwitchSetRequest
            if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值')
            const profile = profileContextOf(ctx)
            if (profile === undefined) {
              throw new HttpError(503, '当前宿主未提供 profileContext（非 profile 启动），无法定位 patch 层')
            }
            const layers = await loadSwitchLayers(profile)
            const view = switchViewOf(ctx, layers)
            if (!view.editable) throw new HttpError(409, view.reason ?? '当前状态不可写')

            const folded = foldWebRows(layers)
            let scope: 'profile' | 'home'
            let written: boolean
            if (body.enabled) {
              if (folded === undefined) {
                // 两层都没有 web 行（生效值来自 bundle 或 base 默认）：以当前
                // 生效配置为底在 home 新建——漏掉 fetchProvider 会把官方抓取打掉。
                const lookup = lookupLiveWeb(ctx.get('loader') as Parameters<typeof lookupLiveWeb>[0], false)
                const base =
                  lookup.introspectable && lookup.entry.origin !== 'missing' && !lookup.entry.disabled
                    ? lookup.entry.config
                    : {}
                appendManagedRow(layers[1].doc, { ...base, searchProvider: ZHIPU_PROVIDER })
                scope = 'home'
                written = true
              } else {
                scope = folded.layer.scope
                written = enableInRow(folded.layer.doc, folded.row)
              }
            } else if (folded === undefined) {
              scope = 'home'
              written = false
            } else {
              scope = folded.layer.scope
              written = disableInRow(folded.layer.doc, folded.row)
            }

            if (written) {
              const layer = layers.find((candidate) => candidate.scope === scope)
              if (layer !== undefined) await writeTextAtomic(layer.file, renderPatchDoc(layer.doc))
            }
            const response: SearchSwitchSetResponse = { enabled: body.enabled, scope, written }
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: errMsg(error) })
          }
        },
      }),
    'dsh-zhipu-tools: search-switch set',
  )
}
