import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { errMsg } from '@dsh-plugins/shared'
import {
  CHECK_PATH,
  DELETE_PATH,
  LIST_PATH,
  MCP_PLUGIN_NAME,
  SAVE_PATH,
  SET_ENABLED_PATH,
  rowIdOf,
  type CheckRequest,
  type DeleteRequest,
  type ListResponse,
  type McpRow,
  type McpScope,
  type SaveRequest,
  type SaveResponse,
  type SetEnabledRequest,
} from './shared'
import { ConfigError, extrasOf, mergeForEdit, normalizeDraft } from './mcpConfig'
import { probeConfig } from './probe'
import { collectLiveMcp } from './live'
// 请求校验函数与 JSON 读写来自共享包（构建期内联）；HttpError 为路由与
// readJsonBody 共用的业务错误类型，同一模块实例保证 instanceof 语义。
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import {
  appendMcpInsert,
  emptyPatchDoc,
  parsePatchDoc,
  removeInsertRow,
  removeOverridesOf,
  renderPatchDoc,
  scanPatchDoc,
  setEnabledInDoc,
  setInsertConfig,
  setOverrideConfig,
  writeTextAtomic,
  type Document,
  type InsertRow,
  type OverrideRow,
} from './patchFile'

export const inject: string[] = ['webServer']

interface Layer {
  scope: McpScope
  file: string
  doc: Document
}

/** 组合出的一条受管 MCP 行：insert 声明 + 按序 fold 的覆盖行。 */
interface ManagedRow {
  scope: McpScope
  insert: InsertRow
  layer: Layer
  overrides: { layer: Layer; row: OverrideRow }[]
  effectiveConfig: Record<string, unknown>
  disabled: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function readPatchText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function loadLayers(profile: { patchPath: string; home: string }): Promise<Layer[]> {
  const files: { scope: McpScope; file: string }[] = [
    { scope: 'profile', file: profile.patchPath },
    { scope: 'home', file: join(profile.home, 'cordis.patch.yml') },
  ]
  const layers: Layer[] = []
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

// 扫描两层文件并组合受管行（profile 行在前、home 行在后的 fold 序）。
function composeManaged(layers: readonly Layer[]): ManagedRow[] {
  const inserts: { layer: Layer; row: InsertRow }[] = []
  const overrides: { layer: Layer; row: OverrideRow }[] = []
  for (const layer of layers) {
    const scanned = scanPatchDoc(layer.doc)
    inserts.push(
      ...scanned.inserts.filter((row) => row.name === MCP_PLUGIN_NAME).map((row) => ({ layer, row })),
    )
    overrides.push(...scanned.overrides.map((row) => ({ layer, row })))
  }
  return inserts.map(({ layer, row }) => {
    const own = overrides.filter(({ row: candidate }) => candidate.id === row.id)
    let effectiveConfig = asRecord(row.config)
    let disabled = row.disabled
    for (const { row: candidate } of own) {
      if (candidate.config !== undefined) effectiveConfig = asRecord(candidate.config)
      if (candidate.disabled !== undefined) disabled = candidate.disabled
    }
    const managed: ManagedRow = {
      scope: layer.scope,
      insert: row,
      layer,
      overrides: own,
      effectiveConfig,
      disabled: disabled === true,
    }
    return managed
  })
}

function serverNameOf(config: Record<string, unknown>): string | undefined {
  return typeof config.serverName === 'string' && config.serverName.length > 0 ? config.serverName : undefined
}

/** 落盘一层（仅写变更过的文件）。 */
async function writeLayers(touched: Iterable<Layer>): Promise<void> {
  for (const layer of touched) {
    await writeTextAtomic(layer.file, renderPatchDoc(layer.doc))
  }
}

function scopeOfRequest(value: unknown): McpScope {
  if (value === 'profile' || value === 'home') return value
  throw new HttpError(400, 'scope 必须是 profile 或 home')
}

export function apply(ctx: Context): void {
  // profileContext / loader / tools / hmr 都是可选访问：官方 web/desktop
  // 组合均提供，不可用时按能力降级而不是拒绝加载。
  const profileContextOf = (): { name: string; patchPath: string; home: string } | undefined => {
    const profile = ctx.get('profileContext') as ProfileContext | undefined
    if (profile === undefined) return undefined
    return { name: profile.name, patchPath: profile.patchPath, home: profile.home }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: LIST_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'GET') {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const profile = profileContextOf()
            if (profile === undefined) {
              writeJson(res, 503, {
                error: '当前宿主未提供 profileContext（非 profile 启动），无法定位 patch 层',
              })
              return
            }
            const layers = await loadLayers(profile)
            const managed = composeManaged(layers)
            const live = await collectLiveMcp(
              ctx.get('loader') as Parameters<typeof collectLiveMcp>[0],
              ctx.get('tools') as Parameters<typeof collectLiveMcp>[1],
            )

            const matched = new Set<string>()
            const servers: McpRow[] = managed.map((row): McpRow => {
              // 受管行只与根树条目匹配（bundle 子树里的同局部 id 不相干）。
              const entry = live.find(
                (candidate) => candidate.patchId === row.insert.id && !candidate.inSubtree,
              )
              if (entry !== undefined) matched.add(entry.patchId)
              return {
                id: row.insert.id,
                scope: row.scope,
                config: row.effectiveConfig,
                disabled: row.disabled,
                editable: true,
                live:
                  entry === undefined
                    ? null
                    : {
                        status: entry.status,
                        tools: entry.tools,
                        error: entry.error,
                      },
              }
            })
            // 只读来源：bundle 子树行 + 根树上未匹配两层的行（--patch 覆盖）。
            for (const entry of live) {
              if (!entry.inSubtree && matched.has(entry.patchId)) continue
              if (!entry.inSubtree && managed.some((row) => row.insert.id === entry.patchId)) continue
              servers.push({
                id: entry.patchId,
                scope: entry.inSubtree ? 'bundle' : 'overlay',
                config: entry.config,
                disabled: entry.disabled,
                editable: false,
                live: {
                  status: entry.status,
                  tools: entry.tools,
                  error: entry.error,
                },
              })
            }
            servers.sort((left, right) => {
              const nameOf = (row: McpRow): string => serverNameOf(row.config) ?? row.id
              return nameOf(left) < nameOf(right) ? -1 : nameOf(left) > nameOf(right) ? 1 : 0
            })
            const response: ListResponse = {
              profileName: profile.name,
              patchPaths: { profile: layers[0].file, home: layers[1].file },
              hotApply: ctx.get('hmr') !== undefined,
              servers,
            }
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-mcp: list bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SAVE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as SaveRequest
            const scope = scopeOfRequest(request.scope)
            const profile = profileContextOf()
            if (profile === undefined)
              throw new HttpError(503, '当前宿主未提供 profileContext，无法定位 patch 层')
            let draft
            try {
              draft = normalizeDraft(request.config)
            } catch (error) {
              const status = error instanceof ConfigError ? 400 : 500
              throw new HttpError(status, errMsg(error))
            }
            // JSON 导入的高级键透传：已知键已被上方严格校验，这里只合并
            // 过滤后的未知键（非法键最终由 Loader 加载时的 schema 校验拒绝）。
            const extra = extrasOf(request.extra)

            const layers = await loadLayers(profile)
            const managed = composeManaged(layers)
            const editing = typeof request.id === 'string' && request.id.length > 0 ? request.id : undefined

            // serverName 全局唯一（运行时按它预留命名空间，重名行会加载失败）。
            const duplicate = managed.find(
              (row) => row.insert.id !== editing && serverNameOf(row.effectiveConfig) === draft.serverName,
            )
            if (duplicate !== undefined) {
              throw new HttpError(409, `serverName「${draft.serverName}」已被 ${duplicate.insert.id} 使用`)
            }

            if (editing === undefined) {
              const id = rowIdOf(draft.serverName)
              for (const layer of layers) {
                if (scanPatchDoc(layer.doc).inserts.some((row) => row.id === id)) {
                  throw new HttpError(409, `patch 行 id「${id}」已被占用（${layer.file}）`)
                }
              }
              const layer = layers.find((candidate) => candidate.scope === scope)
              if (layer === undefined) throw new HttpError(400, `未知的作用域「${scope}」`)
              appendMcpInsert(layer.doc, { id, config: extra === undefined ? draft : { ...draft, ...extra } })
              await writeLayers([layer])
              const response: SaveResponse = { id, scope }
              writeJson(res, 200, response as unknown as Record<string, unknown>)
              return
            }

            const row = managed.find(
              (candidate) => candidate.insert.id === editing && candidate.scope === scope,
            )
            if (row === undefined)
              throw new HttpError(404, `没有找到 id 为「${editing}」的 MCP 行（作用域 ${scope}）`)
            const merged = mergeForEdit([asRecord(row.insert.config), row.effectiveConfig], draft)
            const effective = extra === undefined ? merged : { ...merged, ...extra }
            setInsertConfig(row.layer.doc, row.insert, effective)
            const touched = new Set<Layer>([row.layer])
            for (const override of row.overrides) {
              if (override.row.config === undefined) continue
              setOverrideConfig(override.layer.doc, override.row.patchIndex, effective)
              touched.add(override.layer)
            }
            await writeLayers(touched)
            const response: SaveResponse = { id: editing, scope }
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: errMsg(error) })
          }
        },
      }),
    'dsh-mcp: save bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: CHECK_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as CheckRequest
            let draft
            try {
              draft = normalizeDraft(request.config)
            } catch (error) {
              const status = error instanceof ConfigError ? 400 : 500
              throw new HttpError(status, errMsg(error))
            }
            // 探测失败是结论而不是异常：200 + ok:false 交给前端决定去留。
            const outcome = await probeConfig(draft)
            writeJson(res, 200, outcome as unknown as Record<string, unknown>)
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: errMsg(error) })
          }
        },
      }),
    'dsh-mcp: check bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SET_ENABLED_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as SetEnabledRequest
            const scope = scopeOfRequest(request.scope)
            if (typeof request.id !== 'string' || request.id.length === 0) throw new HttpError(400, '缺少 id')
            if (typeof request.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值')
            const profile = profileContextOf()
            if (profile === undefined)
              throw new HttpError(503, '当前宿主未提供 profileContext，无法定位 patch 层')

            const layers = await loadLayers(profile)
            const managed = composeManaged(layers)
            const row = managed.find(
              (candidate) => candidate.insert.id === request.id && candidate.scope === scope,
            )
            if (row === undefined)
              throw new HttpError(404, `没有找到 id 为「${request.id}」的 MCP 行（作用域 ${scope}）`)

            // 已有携带 disabled 的覆盖行时改最后一处（它才是生效声明），
            // 否则在 insert 所在层追加官方形态的覆盖行。
            const bearing = [...row.overrides]
              .reverse()
              .find(({ row: candidate }) => candidate.disabled !== undefined)
            const target = bearing?.layer ?? row.layer
            const changed = setEnabledInDoc(target.doc, request.id, request.enabled)
            if (changed) await writeLayers([target])
            writeJson(res, 200, { id: request.id, enabled: request.enabled })
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: errMsg(error) })
          }
        },
      }),
    'dsh-mcp: set-enabled bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DELETE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as DeleteRequest
            const scope = scopeOfRequest(request.scope)
            if (typeof request.id !== 'string' || request.id.length === 0) throw new HttpError(400, '缺少 id')
            const profile = profileContextOf()
            if (profile === undefined)
              throw new HttpError(503, '当前宿主未提供 profileContext，无法定位 patch 层')

            const layers = await loadLayers(profile)
            const managed = composeManaged(layers)
            const row = managed.find(
              (candidate) => candidate.insert.id === request.id && candidate.scope === scope,
            )
            if (row === undefined)
              throw new HttpError(404, `没有找到 id 为「${request.id}」的 MCP 行（作用域 ${scope}）`)

            removeInsertRow(row.layer.doc, row.insert)
            const touched = new Set<Layer>([row.layer])
            if (row.overrides.length > 0) {
              for (const layer of layers) {
                removeOverridesOf(layer.doc, request.id)
                touched.add(layer)
              }
            }
            await writeLayers(touched)
            writeJson(res, 200, { removed: true })
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: errMsg(error) })
          }
        },
      }),
    'dsh-mcp: delete bridge',
  )
}
