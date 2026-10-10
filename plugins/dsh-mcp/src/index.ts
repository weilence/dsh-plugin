import { watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { errMsg } from '@dsh-plugins/shared'
import {
  CHECK_PATH,
  CWD_PATH,
  DELETE_PATH,
  GLOBAL_FILENAME,
  LIST_PATH,
  WORKSPACE_FILENAME,
  SAVE_PATH,
  SET_ENABLED_PATH,
  ENTRY_PREFIX,
  entryIdOf,
  type CheckRequest,
  type CwdRequest,
  type DeleteRequest,
  type ListResponse,
  type McpRow,
  type McpScope,
  type SaveRequest,
  type SaveResponse,
  type SetEnabledRequest,
} from './shared'
import { ConfigError, extrasOf, normalizeDraft } from './mcpConfig'
import { probeConfig } from './probe'
import { collectLiveMcp } from './live'
import {
  entryFromDraft,
  parseMcpFile,
  readFileOrNull,
  revisionOf,
  serializeMcpFile,
  writeTextAtomic,
  type McpFileState,
} from './mcpFile'
import { removeAllEntries, syncEntries, type DesiredEntry } from './mcpApply'
// 请求校验函数与 JSON 读写来自共享包（构建期内联）；HttpError 为路由与
// readJsonBody 共用的业务错误类型，同一模块实例保证 instanceof 语义。
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'

export const inject: string[] = ['webServer']

/**
 * MCP 管理的 host half：以两份 .mcp.json（全局 `~/.dsh/mcp.json` 与工作区
 * `<cwd>/.mcp.json`）为持久化事实源，动态挂载 / 更新 / 卸载 Loader 里的
 * mcp-client 行（内存态，不写回任何 cordis 配置文件）。cordis.patch.yml
 * 与其他插件挂的 MCP 行不归本插件管理，面板一律不展示。
 */
export function apply(ctx: Context): void {
  // profileContext / loader / tools 都是可选访问：官方 web/desktop 组合均
  // 提供，不可用时按能力降级而不是拒绝加载。
  const profileOf = (): ProfileContext | undefined => ctx.get('profileContext') as ProfileContext | undefined
  const loaderOf = (): Loader | undefined => ctx.get('loader') as Loader | undefined

  const globalPathOf = (): string | undefined => {
    const profile = profileOf()
    return profile === undefined ? undefined : join(profile.home, GLOBAL_FILENAME)
  }
  const workspacePathOf = (): string | undefined =>
    workspaceCwd === undefined ? undefined : join(workspaceCwd, WORKSPACE_FILENAME)

  /** 工作区档工作目录（client 上报的主视图会话 cwd）；undefined = 工作区档未定。 */
  let workspaceCwd: string | undefined
  let workspaceUnwatch: (() => void) | undefined
  /** 最近一次同步的告警（面板展示）。 */
  let lastWarnings: string[] = []
  /** 串行化同步与工作区切换，避免并发 diff 互相覆盖。 */
  let syncTail: Promise<void> = Promise.resolve()

  const queue = (task: () => Promise<void>): Promise<void> => {
    const run = syncTail.then(task, task)
    syncTail = run.catch(() => {})
    return run
  }

  /** 期望挂载集：两份文件的合法条目；工作区档同名遮蔽全局条目。 */
  const desiredOf = (globalState: McpFileState, workspaceState: McpFileState | null): DesiredEntry[] => {
    const desired: DesiredEntry[] = []
    for (const [name, item] of globalState.valid) {
      if (workspaceState?.valid.has(name) === true) continue
      desired.push({ scope: 'global', name, config: item.config, disabled: item.disabled })
    }
    if (workspaceState !== null) {
      for (const [name, item] of workspaceState.valid) {
        desired.push({ scope: 'workspace', name, config: item.config, disabled: item.disabled })
      }
    }
    return desired
  }

  /** 读两份文件 → 挂载 diff → 应用。解析失败降级为空状态 + 告警（另一份
   *  文件不受影响；写路由面对解析失败会直接报错，不静默）。 */
  const readState = async (
    file: string,
  ): Promise<{ state: McpFileState; text: string | null; warnings: string[] }> => {
    const text = await readFileOrNull(file)
    try {
      return { state: parseMcpFile(text), text, warnings: [] }
    } catch (error) {
      return {
        state: parseMcpFile(null),
        text,
        warnings: [`${basename(file)} 解析失败：${errMsg(error)}`],
      }
    }
  }

  const syncOnce = async (): Promise<void> => {
    const globalFile = globalPathOf()
    const workspaceFile = workspacePathOf()
    const globalRead =
      globalFile === undefined
        ? { state: parseMcpFile(null), text: null, warnings: [] }
        : await readState(globalFile)
    const workspaceRead =
      workspaceFile === undefined
        ? { state: parseMcpFile(null), text: null, warnings: [] }
        : await readState(workspaceFile)
    const warnings = [...globalRead.warnings, ...workspaceRead.warnings]
    warnings.push(
      ...(await syncEntries(
        loaderOf(),
        desiredOf(globalRead.state, workspaceFile === undefined ? null : workspaceRead.state),
      )),
    )
    lastWarnings = warnings
  }

  const runSync = (): Promise<void> => queue(syncOnce)

  /** 工作区档跟随主视图 cwd：切换时重建 watcher 并重新同步（旧工作区条目由
   *  diff 自动卸载）。 */
  const setProjectCwd = (cwd: string | undefined): Promise<void> =>
    queue(async () => {
      if (cwd === workspaceCwd) return
      workspaceCwd = cwd
      workspaceUnwatch?.()
      workspaceUnwatch = undefined
      if (cwd !== undefined) workspaceUnwatch = watchFileIn(cwd, WORKSPACE_FILENAME, runSync)
      await syncOnce()
    })

  // 目录级 watch + 文件名过滤：tmp+mv 原子替换换 inode，盯文件会失效；
  // 盯目录再过滤名称在三个平台都稳。
  function watchFileIn(dir: string, filename: string, onChange: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null
    const watcher = watch(dir, { persistent: false }, (_event, changed) => {
      // 部分平台事件不带文件名（null）：按命中处理，宁可多同步一次。
      if (changed !== null && changed !== filename) return
      if (timer !== null) clearTimeout(timer)
      // 与官方 watcher 相同的稳定窗口，合并编辑器的连续写入。
      timer = setTimeout(() => {
        timer = null
        onChange()
      }, 200)
    })
    watcher.on('error', () => {
      // 目录消失等场景：watcher 失效属预期，下次路由触发会重建（工作区档）。
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      watcher.close()
    }
  }

  /** 请求里的 cwd：空白或缺失 = 工作区档未定。 */
  function cwdOf(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  function scopeOfRequest(value: unknown): McpScope {
    if (value === 'global' || value === 'workspace') return value
    throw new HttpError(400, 'scope 必须是 global 或 workspace')
  }

  /** 读取目标档的文件状态并做乐观并发校验。 */
  async function readTarget(
    file: string,
    revision: string | null,
  ): Promise<{ file: string; state: McpFileState; text: string | null }> {
    const text = await readFileOrNull(file)
    if (revisionOf(text) !== revision) {
      throw new HttpError(409, '文件已被外部修改，请刷新后重试')
    }
    return { file, state: parseMcpFile(text), text }
  }

  /** 定位请求目标文件：global 需要 profileContext；workspace 由请求里的 cwd
   *  定位（缺省沿用已上报的工作区档），并对齐 watcher 与挂载。 */
  async function locateTarget(scope: McpScope, cwd: string | undefined): Promise<string> {
    if (scope === 'global') {
      const file = globalPathOf()
      if (file === undefined) {
        throw new HttpError(503, '当前宿主未提供 profileContext（非 profile 启动），无法定位 ~/.dsh')
      }
      return file
    }
    const requested = cwdOf(cwd) ?? workspaceCwd
    if (requested === undefined) {
      throw new HttpError(409, '工作区档未定位（主视图会话还没有上报工作目录），请稍后重试')
    }
    await setProjectCwd(requested)
    const file = workspacePathOf()
    if (file === undefined) throw new HttpError(409, '工作区档未定位，请稍后重试')
    return file
  }

  ctx.effect(() => {
    const disposers: (() => void)[] = []
    const globalFile = globalPathOf()
    if (globalFile !== undefined) {
      void runSync()
      disposers.push(watchFileIn(dirname(globalFile), GLOBAL_FILENAME, runSync))
    }
    return () => {
      for (const disposer of disposers) disposer()
      workspaceUnwatch?.()
      // 卸掉自己名下的全部动态条目；patch 行与其他插件不受影响。
      removeAllEntries(loaderOf())
    }
  }, 'dsh-mcp: watcher & dynamic entries')

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
            const profile = profileOf()
            const globalFile = globalPathOf()
            if (profile === undefined || globalFile === undefined) {
              writeJson(res, 503, {
                error: '当前宿主未提供 profileContext（非 profile 启动），无法定位 ~/.dsh',
              })
              return
            }
            // 工作区档跟随请求里的 cwd（client 上报的主视图会话目录）；缺省
            // 沿用已上报的档位（会话快照过渡期不清档）。
            const url = new URL(req.url ?? '/', 'http://localhost')
            const cwd = cwdOf(url.searchParams.get('cwd'))
            if (cwd !== undefined) await setProjectCwd(cwd)

            const globalRead = await readState(globalFile)
            const workspaceFile = workspacePathOf()
            const workspaceRead = workspaceFile === undefined ? undefined : await readState(workspaceFile)
            const globalState = globalRead.state
            const workspaceState = workspaceRead?.state

            const live = await collectLiveMcp(
              loaderOf(),
              ctx.get('tools') as Parameters<typeof collectLiveMcp>[1],
            )
            const liveById = new Map(
              live
                .filter((entry) => !entry.inSubtree && entry.patchId.startsWith(ENTRY_PREFIX))
                .map((entry) => [entry.patchId, entry]),
            )
            const liveOf = (scope: McpScope, name: string): McpRow['live'] => {
              const entry = liveById.get(entryIdOf(scope, name))
              return entry === undefined
                ? null
                : { status: entry.status, tools: entry.tools, error: entry.error }
            }

            const servers: McpRow[] = []
            for (const name of [...globalState.valid.keys()].sort()) {
              const item = globalState.valid.get(name)!
              const shadowed = workspaceState?.valid.has(name) === true
              servers.push({
                scope: 'global',
                name,
                config: item.config,
                disabled: item.disabled,
                live: shadowed ? null : liveOf('global', name),
                shadowed: shadowed || undefined,
              })
            }
            if (workspaceState !== undefined) {
              for (const name of [...workspaceState.valid.keys()].sort()) {
                const item = workspaceState.valid.get(name)!
                servers.push({
                  scope: 'workspace',
                  name,
                  config: item.config,
                  disabled: item.disabled,
                  live: liveOf('workspace', name),
                })
              }
            }
            // 不合法条目照样产出（修复或删除靠面板），未挂载。
            for (const name of [...globalState.invalid.keys()].sort()) {
              servers.push({
                scope: 'global',
                name,
                config: {},
                disabled: false,
                live: null,
                invalid: globalState.invalid.get(name),
              })
            }
            for (const name of [...(workspaceState?.invalid.keys() ?? [])].sort()) {
              servers.push({
                scope: 'workspace',
                name,
                config: {},
                disabled: false,
                live: null,
                invalid: workspaceState!.invalid.get(name),
              })
            }

            const response: ListResponse = {
              profileName: profile.name,
              globalPath: globalFile,
              workspacePath: workspaceFile ?? null,
              warnings: [...lastWarnings, ...globalRead.warnings, ...(workspaceRead?.warnings ?? [])],
              revisions: {
                global: revisionOf(globalRead.text),
                workspace: workspaceRead === undefined ? null : revisionOf(workspaceRead.text),
              },
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
        path: CWD_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST') {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as CwdRequest
            await setProjectCwd(cwdOf(request.cwd))
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 500, { error: errMsg(error) })
          }
        },
      }),
    'dsh-mcp: cwd bridge',
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
            const name = typeof request.name === 'string' ? request.name.trim() : ''
            if (name.length === 0) throw new HttpError(400, '缺少服务器名')
            let draft
            try {
              draft = normalizeDraft({ ...request.config, serverName: name })
            } catch (error) {
              const status = error instanceof ConfigError ? 400 : 500
              throw new HttpError(status, errMsg(error))
            }
            // JSON 导入的高级键透传：已知键已被上方严格校验，这里只合并
            // 过滤后的未知键（非法键最终由 Loader 加载时的 schema 校验拒绝）。
            const extra = extrasOf(request.extra)
            if (request.disabled !== undefined && typeof request.disabled !== 'boolean') {
              throw new HttpError(400, 'disabled 必须是布尔值')
            }

            // 同名即编辑（覆盖写入）；改名 = 删除后新建。跨档同名是遮蔽语义，
            // 不拒绝；serverName 冲突由挂载后的 fiber 错误呈现。
            const file = await locateTarget(scope, request.cwd)
            const { state } = await readTarget(file, request.revision)
            const previous = state.valid.get(name)
            const disabled = request.disabled ?? previous?.disabled === true
            state.entries.set(name, entryFromDraft(draft, extra, disabled))
            state.valid.set(name, { config: { ...draft }, disabled })
            state.invalid.delete(name)
            await writeTextAtomic(file, serializeMcpFile(state))
            await runSync()
            const response: SaveResponse = { scope, name }
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
            const name = typeof request.name === 'string' ? request.name.trim() : ''
            if (name.length === 0) throw new HttpError(400, '缺少服务器名')
            if (typeof request.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值')

            const file = await locateTarget(scope, request.cwd)
            const { state } = await readTarget(file, request.revision)
            const entry = state.entries.get(name)
            if (entry === undefined) {
              throw new HttpError(404, `文件里没有名为「${name}」的服务器（${file}）`)
            }
            if (request.enabled) delete entry.disabled
            else entry.disabled = true
            const valid = state.valid.get(name)
            if (valid !== undefined) valid.disabled = !request.enabled
            await writeTextAtomic(file, serializeMcpFile(state))
            await runSync()
            writeJson(res, 200, { name, enabled: request.enabled })
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
            const name = typeof request.name === 'string' ? request.name.trim() : ''
            if (name.length === 0) throw new HttpError(400, '缺少服务器名')

            const file = await locateTarget(scope, request.cwd)
            const { state } = await readTarget(file, request.revision)
            if (!state.entries.has(name)) {
              throw new HttpError(404, `文件里没有名为「${name}」的服务器（${file}）`)
            }
            state.entries.delete(name)
            state.valid.delete(name)
            state.invalid.delete(name)
            await writeTextAtomic(file, serializeMcpFile(state))
            await runSync()
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
