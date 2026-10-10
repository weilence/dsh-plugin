import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, realpath, rename } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'
import { errMsg } from '@dsh-plugins/shared'
import {
  composeLocalRows,
  globalPromptFile,
  profileContextOf,
  readLocalLayers,
  scanGlobalPrompt,
  scanSkillRows,
  skillsRoots,
} from './localenv'
import { RemoteEngine, BusyError, NotFoundError, type EngineDeps } from './engine'
import { ValidationError } from './connections'
import { ForwardRegistry } from './forwards'
import { RemoteTransportService, exchangeTunnelCookie } from './transport'
import { sshExec, startSshForward, tarOverSsh, SshFailure, mergedOutput, summarizeOutput } from './ssh'
import {
  CONNECT_PATH,
  DELETE_PATH,
  LOCAL_ROWS_PATH,
  REMOTE_INVENTORY_PATH,
  SAVE_PATH,
  STATE_PATH,
  SYNC_PATH,
  TEST_PATH,
  VERSION_PATH,
  type LocalRowsResponse,
  type LocalSkillRow,
  type OpRequest,
  type SaveRequest,
  type StateResponse,
  type SyncRequest,
} from './shared'

export const inject: string[] = ['webServer', 'connection']

/** 本机工具探针（结果缓存到进程生命周期）。 */
async function probeTool(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

// 本机 dsh 运行时版本（远端部署对齐目标 + /version 上报值），模块加载时取一次：
// 必须经宿主运行时解析取包（平台包不经 node_modules 供给，静态目录探测落空）；
// 也是快照——getDshRuntimeVersion 运行时读磁盘，远端实例进程里晚读会被连接的
// 部署段升级污染。取不到回 null，部署段据此中止——不回退安装 latest 的论证见
// engine ensureDeployed。
const localDshVersion: string | null = await import('@deepseek-ai/dsh-app-boot')
  .then((boot) => boot.getDshRuntimeVersion())
  .catch(() => null)

/** 构建产物 lib/index.js 所在包根（lib 的上一级）。 */
function pluginPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** 本插件版本，模块加载时定格（远端部署版本对比目标 + /version 上报值）。
 *  必须是快照：远端实例进程里运行时读磁盘会被连接的部署段升级污染——报出
 *  「新版本」而实际跑着旧代码；模块加载即进程启动，此刻磁盘 = 加载的代码。
 *  读不到回 null（部署侧退化为每次重装）。 */
const localPluginVersion: string | null = (() => {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginPackageRoot(), 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : null
  } catch {
    return null
  }
})()

/**
 * 本地组装任意插件包根的 tgz：`pnpm pack` 打包——发布语义（files 白名单、
 * prepack 构建、catalog:/workspace: 依赖落成具体 range），产物名即
 * <扁平化包名>-<version>.tgz。插件判等是版本号（见 shared.pluginStatus），文件
 * 选择不影响判定；workspace 协议不改写则远端 pnpm 解析不了依赖
 * （ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER，catalog: 实际发生过）。
 * 打包走标准工具，不用系统 tar 手拼；宿主进程必须解析得到 pnpm——GUI 启动
 * 不继承 shell rc 的 PATH，找不到直接显式报错，不回退自实现打包（两套打包
 * 行为会让产物不确定）。staging 留在系统 tmp，交给 OS 清理。
 */
export async function packPackage(root: string): Promise<{ path: string; fileName: string }> {
  const real = await realpath(root)
  const staging = await mkdtemp(join(tmpdir(), 'dsh-remote-pack-'))
  // pnpm 的 --json 会被 prepack 脚本的 stdout 污染，产物名不解析输出，改为读
  // 全新空目录里唯一落地的 tgz。Windows 的 pnpm 是 .cmd，node 直接 spawn 会被
  // 拒绝，走 shell 并给路径加引号；unix 保持参数数组不经 shell（临时目录路径
  // 可能含空格）。
  const win32 = process.platform === 'win32'
  const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['pack', win32 ? `--pack-destination="${staging}"` : `--pack-destination=${staging}`],
      { cwd: real, windowsHide: true, shell: win32 },
    )
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += String(chunk)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new SshFailure(
              'local-tool-missing',
              '本机未找到 pnpm：插件同步与部署的打包需要它，且必须在宿主进程可见的 PATH 上',
            )
          : error,
      )
    })
    child.on('close', (code) => {
      resolve({ code: code ?? -1, output })
    })
  })
  if (result.code !== 0) {
    throw new SshFailure('unknown', `pnpm pack 失败：${summarizeOutput('', result.output)}`)
  }
  const files = (await readdir(staging)).filter((name) => name.endsWith('.tgz'))
  if (files.length !== 1) {
    throw new SshFailure('unknown', `pnpm pack 未产出唯一 tgz（得到 ${String(files.length)} 个），无法传输`)
  }
  // 内容盐：tgz 字节的 sha256 前 8 位入文件名。远端 profile 固定 hoisted linker，
  // 同 name@version 重装被 pnpm 判等跳过（--force 也绕不过）——勾选已一致项的
  // 强制重推（典型：改码后忘了 bump version）靠盐变化换 specifier 才会真正重新
  // 解包；内容真一致则同名，远端自然跳过，本来也无事可做。
  const original = join(staging, files[0])
  const salt = createHash('sha256')
    .update(await readFile(original))
    .digest('hex')
    .slice(0, 8)
  const fileName = files[0].replace(/\.tgz$/, `-${salt}.tgz`)
  const path = join(staging, fileName)
  await rename(original, path)
  return { path, fileName }
}

/** 部署自装：本插件打包（prepack 即 tsdown，产物在打包时现建）。 */
async function packPlugin(): Promise<{ path: string; fileName: string }> {
  return packPackage(pluginPackageRoot())
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
    throw new SshFailure(
      'remote-cmd-failed',
      `推送 ${fileName} 失败：${summarizeOutput('', pushed.stderr)}`,
      mergedOutput('', pushed.stderr),
    )
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
    // browser-auth 把守），任何 HTTP 响应都表示隧道可用，仅网络层失败视为不可用。
    healthCheck: async (url) => {
      try {
        await fetch(url, { redirect: 'manual' })
        return true
      } catch {
        return false
      }
    },
    // 经隧道问远端实例的运行身份：token 换 Cookie 后 GET /version（apply 时
    // 定格的快照）。404 = 实例运行着未带该接口的旧插件；其余失败回错误原文，
    // 由引擎按「无法判定」显式失败（不盲目重启）。
    instanceVersion: async (tunnelUrl) => {
      try {
        const url = new URL(tunnelUrl)
        const signal = AbortSignal.timeout(15_000)
        const cookie = await exchangeTunnelCookie(url, signal)
        const response = await fetch(new URL(VERSION_PATH, url.origin), {
          redirect: 'manual',
          signal,
          headers: { cookie, 'sec-fetch-site': 'same-origin', origin: url.origin },
        })
        if (response.status === 404) return { ok: false as const, http: 404 }
        if (!response.ok) return { ok: false as const, http: response.status }
        const body = (await response.json()) as { dsh?: unknown; plugin?: unknown }
        return {
          ok: true as const,
          dsh: typeof body.dsh === 'string' ? body.dsh : null,
          plugin: typeof body.plugin === 'string' ? body.plugin : null,
        }
      } catch (error) {
        return { ok: false as const, error: errMsg(error) }
      }
    },
    pushTar: tarOverSsh,
    pushFile,
    readLocalLayers: () => readLocalLayers(profileContextOf(ctx)),
    // 技能行带内容摘要：引擎的「一致即跳过推送」判定源
    scanSkills: async () => {
      const roots = []
      for (const root of skillsRoots()) {
        roots.push({
          key: root.key,
          path: root.path,
          rows: (await scanSkillRows(root)).map(({ name, digest }) => ({ name, digest })),
        })
      }
      return roots
    },
    readGlobalPrompt: async () => {
      const home = profileContextOf(ctx)?.home ?? dshHomePath()
      try {
        return await readFile(globalPromptFile(home), 'utf8')
      } catch {
        return null
      }
    },
    localDshVersion,
    localPluginVersion,
    packPlugin,
    packPackage,
    forwards: new ForwardRegistry(dshHomePath()),
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

export async function apply(ctx: Context): Promise<void> {
  const engine = makeEngine(ctx)
  // 宿主卸载插件（含退出）时杀掉全部本地转发——spawn 的 ssh 子进程不随父进程
  // 退出而亡，不清理会留下无主转发（实测泄漏过）
  ctx.effect(() => () => engine.dispose())
  await engine.load()
  new RemoteTransportService(ctx, engine)
  applyWithEngine(ctx, engine)
}

/** 路由挂载（engine 注入口：host.test.ts 用假引擎依赖驱动集成往返）。 */
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
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) {
      writeJson(res, rejection, {
        error: rejection === 401 ? '远端请求未通过宿主认证' : '请求来源不允许',
      })
      return false
    }
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
            writeJson(res, 500, { error: errMsg(error) })
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
              const response: LocalRowsResponse = {
                skillRows: [],
                mcpRows: [],
                pluginRows: [],
                promptRow: { path: globalPromptFile(dshHomePath()), digest: null },
                available: false,
              }
              writeJson(res, 200, response as unknown as Record<string, unknown>)
              return
            }
            const { mcpRows, pluginRows } = await composeLocalRows(await readLocalLayers(profile))
            // skills 根与全局提示词是 DSH 用户级全局（非 profile 内），清单与 profile 无关
            const skillRows: LocalSkillRow[] = []
            for (const root of skillsRoots()) skillRows.push(...(await scanSkillRows(root)))
            skillRows.sort((left, right) => left.name.localeCompare(right.name))
            const response: LocalRowsResponse = {
              skillRows,
              mcpRows,
              pluginRows,
              promptRow: await scanGlobalPrompt(profile.home),
              available: true,
            }
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, 500, { error: errMsg(error) })
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
            writeJson(res, statusOf(error), { error: errMsg(error) })
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
            writeJson(res, statusOf(error), { error: errMsg(error) })
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
            writeJson(res, statusOf(error), { error: errMsg(error) })
          }
        },
      }),
    'dsh-remote: test bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: REMOTE_INVENTORY_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!guard(req, res, 'POST')) return
            const id = await connIdOf(req)
            const response = await engine.remoteInventory(id)
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, statusOf(error), { error: errMsg(error) })
          }
        },
      }),
    'dsh-remote: remote-inventory bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: CONNECT_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!guard(req, res, 'POST')) return
            const id = await connIdOf(req)
            await engine.load()
            engine.connectionOf(id)
            engine.startConnect(id)
            const row = engine.rows().find((candidate) => candidate.id === id)
            writeJson(res, 200, { started: true, state: row?.state ?? null })
          } catch (error) {
            writeJson(res, statusOf(error), { error: errMsg(error) })
          }
        },
      }),
    'dsh-remote: connect bridge',
  )

  // 实例运行身份上报（连接的版本判定用）：两个值都是模块加载时定格的快照——
  // 远端实例进程里此刻磁盘 = 加载的代码；运行时读会被连接的部署段升级污染。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: VERSION_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res, 'GET')) return
          writeJson(res, 200, { dsh: localDshVersion, plugin: localPluginVersion })
        },
      }),
    'dsh-remote: version bridge',
  )

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
            if (
              request.kind !== 'skills' &&
              request.kind !== 'mcp' &&
              request.kind !== 'plugins' &&
              request.kind !== 'prompts'
            ) {
              throw new HttpError(400, 'kind 必须是 skills / mcp / plugins / prompts')
            }
            if (!Array.isArray(request.names) || request.names.some((name) => typeof name !== 'string')) {
              throw new HttpError(400, 'names 必须是字符串数组（勾选清单随请求直传）')
            }
            await engine.load()
            engine.connectionOf(request.id)
            engine.startSync(request.id, request.kind, request.names, request.registryPluginInstall)
            const row = engine.rows().find((candidate) => candidate.id === request.id)
            writeJson(res, 200, { started: true, state: row?.state ?? null })
          } catch (error) {
            writeJson(res, statusOf(error), { error: errMsg(error) })
          }
        },
      }),
    'dsh-remote: sync bridge',
  )
}
