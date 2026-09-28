/**
 * dsh-remote host half：设置页「远程开发」面板的 HTTP 桥。
 *
 * 引擎（engine.ts）持有连接状态机并经 ssh 推进部署 / 连接 / 同步；本模块
 * 只做三件事：把引擎钉在路由上（GET /state 轮询、POST 点火）、栅栏守卫
 * （@dsh-plugins/shared/http 同源防线）、本机效应的生产接线（ssh 执行器、
 * 端口预占、健康检查、本机清单读取）。
 *
 * profileContext 经 ctx.get() 可选访问——缺席时本机 MCP / 插件清单降级为
 * 不可用，连接管理与部署不受影响。
 *
 * @module dsh-remote
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { composeLocalRows, profileContextOf, readLocalLayers, scanSkillsNames, skillsRoots } from './localenv'
import { RemoteEngine, BusyError, NotFoundError, type EngineDeps } from './engine'
import { ValidationError } from './connections'
import { sshExec, startSshForward, tarOverSsh, SshFailure } from './ssh'
import {
  REMOTE_PLUGIN_NAME,
  type LocalRowsResponse,
  type OpRequest,
  type SaveRequest,
  type StateResponse,
  type SyncRequest,
} from './shared'

export const inject: string[] = ['webServer']

export const STATE_PATH = '/dsh-remote/state'
export const LOCAL_ROWS_PATH = '/dsh-remote/local-rows'
export const SAVE_PATH = '/dsh-remote/save'
export const DELETE_PATH = '/dsh-remote/delete'
export const TEST_PATH = '/dsh-remote/test'
export const DEPLOY_PATH = '/dsh-remote/deploy'
export const CONNECT_PATH = '/dsh-remote/connect'
export const DISCONNECT_PATH = '/dsh-remote/disconnect'
export const SYNC_PATH = '/dsh-remote/sync'

/** 本机工具探针（结果缓存到进程生命周期）。 */
async function probeTool(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

/**
 * 本机 dsh 运行时版本：沿 Node 的 node_modules 查找序探测
 * `@deepseek-ai/dsh-app-boot/package.json`（官方 getDshRuntimeVersion 的同源
 * 事实）。软探测——本仓开发态等解析不到的场合回 null，远端退装 latest。
 */
function localDshVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    for (const searchPath of require.resolve.paths('@deepseek-ai/dsh-app-boot') ?? []) {
      const manifest = join(searchPath, '@deepseek-ai/dsh-app-boot', 'package.json')
      if (!existsSync(manifest)) continue
      const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version
      return typeof version === 'string' && version.length > 0 ? version : null
    }
  } catch {
    // 软探测：任何失败都按未知处理
  }
  return null
}

/** 构建产物 lib/index.js 所在包根（lib 的上一级）。 */
function pluginPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** 本插件版本（远端部署版本对比目标）；读不到回 null（部署侧退化为每次重装）。 */
function localPluginVersion(): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginPackageRoot(), 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * 本地组装插件 tgz（npm tarball 布局：package/ 前缀）。不用 `pnpm pack`——
 * 宿主形态（desktop / web CLI）不保证带着包管理器；系统 tar（Windows 10+
 * 自带 bsdtar）+ files 清单拷贝即可产出 pnpm 可安装的包。staging 留在系统
 * tmp 目录，量级几十 KB，交给 OS 清理。
 */
async function packPlugin(): Promise<{ path: string; fileName: string }> {
  const root = pluginPackageRoot()
  const version = localPluginVersion()
  if (version === null) throw new SshFailure('unknown', '本插件 package.json 缺 version，无法打包')
  for (const artifact of ['lib/index.js', 'lib/client.js']) {
    if (!existsSync(join(root, artifact)))
      throw new SshFailure('unknown', `本插件缺少构建产物 ${artifact}：先在插件目录执行 pnpm build`)
  }
  const staging = await mkdtemp(join(tmpdir(), 'dsh-remote-pack-'))
  const bundle = join(staging, 'package')
  await mkdir(bundle, { recursive: true })
  await copyFile(join(root, 'package.json'), join(bundle, 'package.json'))
  await copyFile(join(root, 'cordis.patch.yml'), join(bundle, 'cordis.patch.yml'))
  await cp(join(root, 'lib'), join(bundle, 'lib'), { recursive: true })
  // npm 对 scoped 包的 tarball 命名规则：@weilence/dsh-remote → weilence-dsh-remote
  const fileName = `${REMOTE_PLUGIN_NAME.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
  const tarball = join(staging, fileName)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-czf', tarball, '-C', staging, 'package'], { windowsHide: true })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new SshFailure(
              'local-tool-missing',
              '本机未找到 tar：Windows 10+ 自带 bsdtar，请确认其在 PATH 上',
            )
          : error,
      )
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new SshFailure('unknown', `tar 打包失败（退出码 ${String(code)}）`))
    })
  })
  return { path: tarball, fileName }
}

/** 单文件二进制推送：tgz 经 ssh stdin 直写远端 payload 目录。 */
async function pushFile(
  alias: string,
  localPath: string,
  remoteDir: string,
  fileName: string,
): Promise<void> {
  const payload = await readFile(localPath)
  const pushed = await sshExec(alias, `mkdir -p ${remoteDir} && cat > ${remoteDir}/${fileName}`, {
    stdin: payload,
    timeoutMs: 120_000,
  })
  if (pushed.code !== 0)
    throw new SshFailure('remote-cmd-failed', `推送 ${fileName} 失败：${pushed.stderr.trim().slice(0, 200)}`)
}

function makeEngine(ctx: Context): RemoteEngine {
  const deps: EngineDeps = {
    exec: sshExec,
    startForward: startSshForward,
    freeLocalPort: () =>
      new Promise<number>((resolve, reject) => {
        const server = createServer()
        server.unref()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          const port = typeof address === 'object' && address !== null ? address.port : 0
          server.close(() => resolve(port))
        })
      }),
    // 健康检查只证明隧道通：远端对无凭据的 GET / 应答 401（index 由
    // browser-auth 把守），任何 HTTP 响应都算隧道活着，仅网络层失败为死。
    healthCheck: async (url) => {
      try {
        await fetch(url, { redirect: 'manual' })
        return true
      } catch {
        return false
      }
    },
    pushTar: tarOverSsh,
    pushFile,
    readLocalLayers: () => readLocalLayers(profileContextOf(ctx)),
    scanSkills: async () => {
      const roots = []
      for (const root of skillsRoots())
        roots.push({ key: root.key, path: root.path, names: await scanSkillsNames(root) })
      return roots
    },
    tools: { ssh: true, tar: true },
    localDshVersion: localDshVersion(),
    localPluginVersion: localPluginVersion(),
    packPlugin,
    homeDir: dshHomePath(),
    now: () => new Date().toISOString(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
  return new RemoteEngine(deps)
}

function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.status
  if (error instanceof ValidationError) return 400
  if (error instanceof BusyError) return 409
  if (error instanceof NotFoundError) return 404
  return 500
}

export function apply(ctx: Context): void {
  applyWithEngine(ctx, makeEngine(ctx))
}

/** 桥路由挂载（engine 注入口：host.test.ts 用假引擎依赖驱动集成往返）。 */
export function applyWithEngine(ctx: Context, engine: RemoteEngine): void {
  let toolsProbe: Promise<{ ssh: boolean; tar: boolean }> | undefined

  const probeTools = (): Promise<{ ssh: boolean; tar: boolean }> => {
    toolsProbe ??= Promise.all([probeTool('ssh', ['-V']), probeTool('tar', ['--version'])]).then(
      ([ssh, tar]) => ({
        ssh,
        tar,
      }),
    )
    return toolsProbe
  }

  const guard = (req: IncomingMessage, res: ServerResponse, method: 'GET' | 'POST'): boolean => {
    if (!isExpectedHost(req, ctx.webServer.host) || req.method !== method) {
      writeJson(res, 403, { error: 'forbidden' })
      return false
    }
    if (method === 'POST' && !isTrustedFetch(req)) {
      writeJson(res, 403, { error: 'forbidden' })
      return false
    }
    return true
  }

  const connIdOf = async (req: IncomingMessage): Promise<string> => {
    const body = await readJsonBody(req)
    const id = (body as unknown as OpRequest).id
    if (typeof id !== 'string' || id.length === 0) throw new HttpError(400, '缺少 id')
    return id
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!guard(req, res, 'GET')) return
            await engine.load()
            const profile = profileContextOf(ctx)
            const tools = await probeTools()
            const response: StateResponse = {
              env: {
                profileName: profile?.name ?? null,
                home: dshHomePath(),
                ssh: tools.ssh,
                tar: tools.tar,
              },
              connections: engine.rows(),
            }
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, 500, { error: String(error instanceof Error ? error.message : error) })
          }
        },
      }),
    'dsh-remote: state bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: LOCAL_ROWS_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!guard(req, res, 'GET')) return
            const profile = profileContextOf(ctx)
            if (profile === undefined) {
              const response: LocalRowsResponse = { mcpRows: [], pluginRows: [], available: false }
              writeJson(res, 200, response as unknown as Record<string, unknown>)
              return
            }
            const { mcpRows, pluginRows } = composeLocalRows(await readLocalLayers(profile))
            const response: LocalRowsResponse = { mcpRows, pluginRows, available: true }
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, 500, { error: String(error instanceof Error ? error.message : error) })
          }
        },
      }),
    'dsh-remote: local-rows bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SAVE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!guard(req, res, 'POST')) return
            const body = await readJsonBody(req)
            const response = await engine.save(body as unknown as SaveRequest)
            writeJson(res, 200, response)
          } catch (error) {
            writeJson(res, statusOf(error), { error: String(error instanceof Error ? error.message : error) })
          }
        },
      }),
    'dsh-remote: save bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DELETE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!guard(req, res, 'POST')) return
            const id = await connIdOf(req)
            await engine.remove(id)
            writeJson(res, 200, { removed: true })
          } catch (error) {
            writeJson(res, statusOf(error), { error: String(error instanceof Error ? error.message : error) })
          }
        },
      }),
    'dsh-remote: delete bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: TEST_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!guard(req, res, 'POST')) return
            const id = await connIdOf(req)
            const response = await engine.test(id)
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, statusOf(error), { error: String(error instanceof Error ? error.message : error) })
          }
        },
      }),
    'dsh-remote: test bridge',
  )

  const fire = (path: string, ignite: (id: string) => void, label: string): void => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler: async (req: IncomingMessage, res: ServerResponse) => {
            try {
              if (!guard(req, res, 'POST')) return
              const id = await connIdOf(req)
              await engine.load()
              engine.connectionOf(id)
              ignite(id)
              const row = engine.rows().find((candidate) => candidate.id === id)
              writeJson(res, 200, { started: true, state: row?.state ?? null })
            } catch (error) {
              writeJson(res, statusOf(error), {
                error: String(error instanceof Error ? error.message : error),
              })
            }
          },
        }),
      label,
    )
  }

  fire(DEPLOY_PATH, (id) => engine.startDeploy(id), 'dsh-remote: deploy bridge')
  fire(CONNECT_PATH, (id) => engine.startConnect(id), 'dsh-remote: connect bridge')
  fire(DISCONNECT_PATH, (id) => engine.startDisconnect(id), 'dsh-remote: disconnect bridge')

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SYNC_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!guard(req, res, 'POST')) return
            const body = await readJsonBody(req)
            const request = body as unknown as SyncRequest
            if (request.kind !== 'skills' && request.kind !== 'mcp' && request.kind !== 'plugins') {
              throw new HttpError(400, 'kind 必须是 skills / mcp / plugins')
            }
            await engine.load()
            engine.connectionOf(request.id)
            engine.startSync(request.id, request.kind)
            const row = engine.rows().find((candidate) => candidate.id === request.id)
            writeJson(res, 200, { started: true, state: row?.state ?? null })
          } catch (error) {
            writeJson(res, statusOf(error), { error: String(error instanceof Error ? error.message : error) })
          }
        },
      }),
    'dsh-remote: sync bridge',
  )
}
