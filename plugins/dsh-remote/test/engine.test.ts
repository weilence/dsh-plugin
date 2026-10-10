/**
 * 连接引擎：fake ssh / 转发 / 扫描依赖上的全链集成——save/test/connect
 * （含部署段：环境装配 / tgz 推送 / 版本对比 / 实例版本判定与重启回环）
 * /三类同步（一致跳过 / 覆盖 / 未勾选不动 / 不删除远端）/互斥/删除。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BusyError,
  RemoteEngine,
  REMOTE_PLUGIN_FACTS_SCRIPT,
  type EngineDeps,
  type InstanceVersion,
} from '../src/engine'
import type { ForwardHandle, SshResult } from '../src/ssh'
import { ForwardRegistry } from '../src/forwards'
import { emptyPatchDoc, parsePatchDoc, renderPatchDoc, upsertInsertRow } from '../src/patchDoc'
import { readStore, writeStore } from '../src/connections'
import { foldSkillDigest, type LocalPatchLayer } from '../src/localenv'
import { mcpSignature, type SaveRequest } from '../src/shared'

interface Recorded {
  alias: string
  command: string
  stdin?: string | Uint8Array
}

const OK: SshResult = { code: 0, stdout: '', stderr: '' }

/** 64 位十六进制摘要（远端管线输出行的哈希段形态）。 */
const hex = (char: string): string => char.repeat(64)

/** 部署段直通脚本：远端已装齐且版本一致（与 makeDeps 缺省版本对齐）——
 *  连接测试不关心装配细节时前置它，让流程直达启动段。六项事实一次探查返回。 */
function deployReady(command: string): SshResult | undefined {
  if (command.includes('__NODE__')) {
    return {
      code: 0,
      stdout:
        '__NODE__v22.19.0\n__NPM__10.8.2\n__PNPM__10.12.0\n__DSH__0.1.7-rc.2\n' +
        '__PLUGIN__{"name":"@weilence/dsh-remote","version":"0.1.0"}\n__REG__1\n',
      stderr: '',
    }
  }
  return undefined
}

/** 就绪轮询命中：launch 行 + 同连接附带的 pid。 */
function launchResult(): SshResult {
  return { code: 0, stdout: 'dsh web: http://127.0.0.1:4321/?token=tok43\n__PID__4242\n', stderr: '' }
}

interface FakeOptions {
  /** 按命令文本返回结果；未命中回 OK。抛异常则原样传播。 */
  respond?: (command: string) => SshResult | Promise<SshResult> | undefined
  profilePatch?: string
  homePatch?: string
  /** profile 层所在目录（registry 包实体定位在层内 node_modules 下）。 */
  layerDir?: string
  /** 层 package.json 的 dependencies（install 形态判定依据）。 */
  profileDeps?: Record<string, string>
  /** 技能扫描结果（name + 内容摘要；引擎「一致即跳过」的判定输入）。 */
  skills?: {
    key: 'user-dsh' | 'user-agents'
    path: string
    rows: { name: string; digest: string | null }[]
  }[]
  /** 本机全局提示词（AGENTS.md）内容；缺省 null（本机没有该文件）。 */
  globalPrompt?: string | null
  tar?: boolean
  /** 本机 dsh 版本（部署对齐目标）；缺省 0.1.7-rc.2。 */
  localDshVersion?: string | null
  /** 本插件版本（部署版本对比目标）；缺省 0.1.0。 */
  localPluginVersion?: string | null
  /** 经隧道问到的实例版本；函数形式按判定次序变化（回环用例），缺省与本机
   *  版本一致（复用直连）。 */
  instanceVersion?: InstanceVersion | ((attempt: number) => InstanceVersion)
  /** 健康检查结果；函数形式按尝试次序变化（自愈回环用例），缺省恒 true。 */
  healthCheck?: (attempt: number) => boolean
}

function makeDeps(options: FakeOptions = {}) {
  const calls: Recorded[] = []
  const tarPushes: { alias: string; localRoot: string; remoteRoot: string; names?: readonly string[] }[] = []
  const filePushes: { alias: string; localPath: string; remoteDir: string; fileName: string }[] = []
  const packedRoots: string[] = []
  let forwardKilled = 0
  let packCount = 0
  let versionAttempt = 0
  let healthAttempt = 0
  const deps: EngineDeps = {
    async exec(alias, command, execOptions) {
      calls.push({ alias, command, stdin: execOptions?.stdin })
      const scripted = options.respond?.(command)
      if (scripted instanceof Promise) return scripted
      return scripted ?? OK
    },
    async instanceVersion() {
      versionAttempt += 1
      const scripted = options.instanceVersion
      if (scripted === undefined) {
        return {
          ok: true as const,
          dsh: options.localDshVersion === undefined ? '0.1.7-rc.2' : options.localDshVersion,
          plugin: options.localPluginVersion === undefined ? '0.1.0' : options.localPluginVersion,
        }
      }
      return typeof scripted === 'function' ? scripted(versionAttempt) : scripted
    },
    startForward(alias, localPort, remotePort): ForwardHandle {
      return {
        kill() {
          forwardKilled += 1
        },
        onExit() {},
        pid: 4242,
      }
    },
    freeLocalPort: async () => 19999,
    async healthCheck() {
      healthAttempt += 1
      return options.healthCheck === undefined ? true : options.healthCheck(healthAttempt)
    },
    async pushTar(alias, localRoot, remoteRoot, names) {
      tarPushes.push({ alias, localRoot, remoteRoot, names })
    },
    async pushFile(alias, localPath, remoteDir, fileName) {
      filePushes.push({ alias, localPath, remoteDir, fileName })
    },
    readLocalLayers: async () => {
      const layers: LocalPatchLayer[] = [
        {
          source: 'profile',
          file: join(options.layerDir ?? '/profile', 'cordis.patch.yml'),
          doc: options.profilePatch === undefined ? emptyPatchDoc() : parsePatchDoc(options.profilePatch),
          deps: options.profileDeps ?? {},
        },
        {
          source: 'home',
          file: '/home/cordis.patch.yml',
          doc: options.homePatch === undefined ? emptyPatchDoc() : parsePatchDoc(options.homePatch),
          deps: {},
        },
      ]
      return layers
    },
    scanSkills: async () => options.skills ?? [],
    readGlobalPrompt: async () => options.globalPrompt ?? null,
    localDshVersion: options.localDshVersion === undefined ? '0.1.7-rc.2' : options.localDshVersion,
    localPluginVersion: options.localPluginVersion === undefined ? '0.1.0' : options.localPluginVersion,
    async packPlugin() {
      packCount += 1
      return { path: 'C:/tmp/weilence-dsh-remote-0.1.0.tgz', fileName: 'weilence-dsh-remote-0.1.0.tgz' }
    },
    async packPackage(root) {
      packedRoots.push(root)
      return { path: `C:/tmp/packed.tgz`, fileName: 'packed-1.0.0.tgz' }
    },
    forwards: new ForwardRegistry(''),
    homeDir: '',
    now: () => '2027-01-01T00:00:00.000Z',
    delay: async () => {},
  }
  return {
    deps,
    calls,
    tarPushes,
    filePushes,
    packedRoots: () => packedRoots,
    forwardCount: () => forwardKilled,
    packCount: () => packCount,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('waitFor 超时')
}

function saveRequest(overrides: Partial<SaveRequest> = {}): SaveRequest {
  return {
    label: '开发机',
    sshAlias: 'dev-box',
    ...overrides,
  }
}

describe('RemoteEngine', () => {
  let home: string
  let engine: RemoteEngine
  let fake: ReturnType<typeof makeDeps>

  function makeEngine(options: FakeOptions = {}): RemoteEngine {
    fake = makeDeps(options)
    fake.deps.homeDir = home
    fake.deps.forwards = new ForwardRegistry(home)
    engine = new RemoteEngine(fake.deps)
    return engine
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-remote-engine-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('save → rows：id 派生与状态快照', async () => {
    makeEngine()
    const { id } = await engine.save(saveRequest())
    expect(id).toBe('dev-box')
    const rows = engine.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'dev-box', sshAlias: 'dev-box', state: { phase: 'idle', op: null } })
  })

  it('test：合并探针解析三段版本', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('node -v && npm -v')) {
          return { code: 0, stdout: 'v22.19.0\n10.8.2\n0.1.7-rc.2\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    const result = await engine.test('dev-box')
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({ nodeVersion: 'v22.19.0', npmVersion: '10.8.2', dshVersion: '0.1.7-rc.2' })
    expect(engine.stateOf('dev-box').phase).toBe('idle')
  })

  it('connect 部署段：未装 → 打包推送 tgz 并安装（web profile），verify 读回版本', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('__NODE__')) {
          // 插件未装：PLUGIN 空、REG 0
          return {
            code: 0,
            stdout:
              '__NODE__v22.19.0\n__NPM__10.8.2\n__PNPM__10.12.0\n__DSH__0.1.7-rc.2\n__PLUGIN__\n__REG__0\n',
            stderr: '',
          }
        }
        if (command.includes('dsh plugin --profile') && command.includes(' add ')) {
          // add 同条连接附带 verify 读回：装上了 0.1.0
          return {
            code: 0,
            stdout: '__VERIFY__{"name":"@weilence/dsh-remote","version":"0.1.0"}\n',
            stderr: '',
          }
        }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    const state = engine.stateOf('dev-box')
    expect(state.running).not.toBeNull()
    expect(state.error).toBeNull()
    const commands = fake.calls.map((call) => call.command)
    expect(
      commands.some(
        (command) =>
          command.includes('dsh plugin --profile') &&
          command.includes(' add ') &&
          command.includes('__VERIFY__'),
      ),
    ).toBe(true)
    expect(fake.packCount()).toBe(1)
    expect(fake.filePushes).toEqual([
      {
        alias: 'dev-box',
        localPath: 'C:/tmp/weilence-dsh-remote-0.1.0.tgz',
        remoteDir: '~/.dsh/dsh-remote/payload',
        fileName: 'weilence-dsh-remote-0.1.0.tgz',
      },
    ])
    expect(commands.some((command) => command.includes('npm install -g'))).toBe(false)
  })

  it('connect 部署段：远端已装同版本且 profile 已登记 → 跳过打包与安装', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(fake.packCount()).toBe(0)
    expect(fake.filePushes).toEqual([])
    expect(fake.calls.some((call) => call.command.includes('dsh plugin '))).toBe(false)
    expect(engine.stateOf('dev-box').op).toBeNull()
  })

  it('connect 部署段：add 成功但读不回版本 → error（假阳性防线）', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('__NODE__')) {
          // 插件未装：PLUGIN 空、REG 0
          return {
            code: 0,
            stdout:
              '__NODE__v22.19.0\n__NPM__10.8.2\n__PNPM__10.12.0\n__DSH__0.1.7-rc.2\n__PLUGIN__\n__REG__0\n',
            stderr: '',
          }
        }
        // add 成功但同条连接读不回（VERIFY 空）
        if (command.includes('dsh plugin --profile') && command.includes(' add ')) return OK
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('error')
    expect(state.error).toMatchObject({ kind: 'remote-cmd-failed' })
    expect(state.error?.message).toContain('读不回')
  })

  it('connect 部署段：远端 dsh 版本与本机不一致 → npm 装对齐版本', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('__NODE__')) {
          return {
            code: 0,
            stdout:
              '__NODE__v22.19.0\n__NPM__10.8.2\n__PNPM__10.12.0\n__DSH__0.1.0\n' +
              '__PLUGIN__{"name":"@weilence/dsh-remote","version":"0.1.0"}\n__REG__1\n',
            stderr: '',
          }
        }
        if (command.includes('dsh plugin --profile') && command.includes(' add ')) {
          return {
            code: 0,
            stdout: '__VERIFY__{"name":"@weilence/dsh-remote","version":"0.1.0"}\n',
            stderr: '',
          }
        }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(fake.calls.some((call) => call.command === "npm install -g '@deepseek-ai/dsh@0.1.7-rc.2'")).toBe(
      true,
    )
  })

  it('connect 部署段：本机版本探测失败（null）→ 直接失败，不回退安装 latest', async () => {
    makeEngine({
      localDshVersion: null,
      respond: (command) => {
        if (command.includes('__NODE__')) {
          return {
            code: 0,
            stdout:
              '__NODE__v22.19.0\n__NPM__10.8.2\n__PNPM__10.12.0\n__DSH__0.1.7-rc.2\n__PLUGIN__\n__REG__0\n',
            stderr: '',
          }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('error')
    expect(state.error?.message).toContain('探测失败')
    // 不得出现任何 npm install（不回退安装 latest）
    expect(fake.calls.some((call) => call.command.includes('npm install -g'))).toBe(false)
  })

  it('connect 部署段：远端缺 node → error 阶段（remote-cmd-failed）', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('__NODE__')) {
          return {
            code: 0,
            stdout:
              '__NODE__bash: node: command not found\n__NPM__10.8.2\n__PNPM__10.12.0\n__DSH__\n__PLUGIN__\n__REG__0\n',
            stderr: '',
          }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('error')
    expect(state.error).toMatchObject({ kind: 'remote-cmd-failed' })
    expect(state.error?.message).toContain('Node')
  })

  it('connect 部署段：远端缺 pnpm → error 并指路手动安装（不做 corepack 自动启用）', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('__NODE__')) {
          return {
            code: 0,
            stdout:
              '__NODE__v22.19.0\n__NPM__10.8.2\n__PNPM__bash: pnpm: command not found\n__DSH__\n__PLUGIN__\n__REG__0\n',
            stderr: '',
          }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('error')
    expect(state.error).toMatchObject({ kind: 'remote-cmd-failed' })
    expect(state.error?.message).toContain('npm install -g pnpm')
    // 不尝试 corepack，也不推进到 dsh 安装
    expect(fake.calls.some((call) => call.command.includes('corepack'))).toBe(false)
    expect(fake.calls.some((call) => call.command.includes('npm install -g'))).toBe(false)
  })

  const REMOTE_PATCH = `# 远端手写注释
- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: demo
        command: npx
- insert:
    - id: custom-hand
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: hand
        command: old-cmd
`

  it('connect：部署段直通 → start → poll token → forward → health → running（连接路径零同步）', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      skills: [
        {
          key: 'user-dsh',
          path: 'C:/skills',
          rows: [
            { name: 'alpha', digest: 'a' },
            { name: 'beta', digest: 'b' },
          ],
        },
      ],
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    const state = engine.stateOf('dev-box')
    expect(state.running).toMatchObject({
      url: 'http://127.0.0.1:19999/?token=tok43',
      localPort: 19999,
      remotePort: 4321,
      pid: 4242,
    })
    // 连接路径零同步动作：skills 只在手动「同步 skills」时推送
    expect(fake.tarPushes).toEqual([])
    expect(state.lastSync.skills).toBeNull()
  })

  it('运行中同步失败只报告操作错误，不丢失仍在运行的转发', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      globalPrompt: null,
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )

    engine.startSync('dev-box', 'prompts', ['AGENTS.md'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(engine.stateOf('dev-box')).toMatchObject({
      phase: 'running',
      running: { localPort: 19999 },
      error: { message: expect.stringContaining('本机没有全局提示词') },
    })
    expect(fake.forwardCount()).toBe(0)
  })

  it('转发租约：connect 落盘、删除连接清除、新引擎 load 清扫上个生命周期遗留', async () => {
    // 宿主重启会清空内存运行态但 ssh 子进程可能存活——租约让面板的 idle
    // 与本机进程不再各说各话（现场：面板 idle + 隧道端口仍在应答 401）
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    const leasePath = join(home, 'dsh-remote', 'forwards.json')
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toEqual({
      'dev-box': { pid: 4242, localPort: 19999, remotePort: 4321, at: '2027-01-01T00:00:00.000Z' },
    })

    // 删除 = 本地全清（运行中也可删）：转发与租约一并消失，远端实例不动
    await engine.remove('dev-box')
    expect(fake.forwardCount()).toBe(1)
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toEqual({})
    await engine.save(saveRequest())

    // 模拟上个宿主生命周期遗留：租约在、进程归属未知——load 时核验后杀掉
    await writeFile(
      leasePath,
      JSON.stringify({
        'dev-box': { pid: 5555, localPort: 20001, remotePort: 4321, at: '2027-01-01T00:00:00.000Z' },
      }),
      'utf8',
    )
    const killed: { pid: number; localPort: number }[] = []
    const reborn = new RemoteEngine({
      ...fake.deps,
      forwards: new ForwardRegistry(home, async (pid, localPort) => {
        killed.push({ pid, localPort })
        return 'killed'
      }),
    })
    await reborn.load()
    expect(reborn.stateOf('dev-box').phase).toBe('idle')
    expect(killed).toEqual([{ pid: 5555, localPort: 20001 }])
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toEqual({})
  })

  it('connect 重连先杀旧转发：句柄覆盖前必须 kill，否则 ssh 进程无主泄漏', async () => {
    // 实测事故：error 阶段重连时旧 forward 仍挂在 runtime 上，runConnect 直接
    // 覆盖句柄 → 旧 ssh -N -L 进程失去引用，累积成无主转发
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(fake.forwardCount()).toBe(0) // 首次连接：无旧转发可杀
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(fake.forwardCount()).toBe(1) // 重连杀掉了旧转发
  })

  it('connect：远端实例仍存活且版本一致时复用（不叠加新 nohup 实例）', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('echo reuse:')) return { code: 0, stdout: 'reuse:4242\n', stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(engine.stateOf('dev-box').running).toMatchObject({ pid: 4242, remotePort: 4321 })
    // 复用直连：不杀实例（无 stopInstance 命令）、只建一次转发
    expect(fake.calls.some((call) => call.command.includes('ps -p'))).toBe(false)
    expect(fake.forwardCount()).toBe(0)
  })

  it('connect：token 行迟迟不出现 → timeout 错误并附日志尾部', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return OK
        if (command.includes('tail -n 20')) return { code: 0, stdout: 'boom\nboom\n', stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    const state = engine.stateOf('dev-box')
    expect(state.error?.kind).toBe('timeout')
    expect(state.error?.message).toContain('boom')
  })

  it('connect：复用实例自报版本落后 → 杀旧重启收敛（一轮回环）', async () => {
    // 场景：本机 dsh 已升级，部署段把磁盘升到新版本，但活实例进程还是旧代码
    // ——实例经 /version 自报旧版本，不匹配 → 杀旧（身份核验 + 子进程补杀 +
    // pid 清除 + 日志截断）→ 新启动加载新磁盘 → 二轮判定通过。
    let startCount = 0
    makeEngine({
      localDshVersion: '0.2.0',
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('echo reuse:')) {
          startCount += 1
          return startCount === 1
            ? { code: 0, stdout: 'reuse:4242\n', stderr: '' }
            : { code: 0, stdout: '', stderr: '' }
        }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      instanceVersion: (attempt) =>
        attempt === 1
          ? { ok: true, dsh: '0.1.7-rc.2', plugin: '0.1.0' }
          : { ok: true, dsh: '0.2.0', plugin: '0.1.0' },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(engine.stateOf('dev-box').running).toMatchObject({ pid: 4242 })
    const stop = fake.calls.find((call) => call.command.includes('ps -p'))
    expect(stop?.command).toContain('pkill -P "$pid"')
    expect(stop?.command).toContain('rm -f')
    expect(stop?.command).toContain(': >')
    // 真实 bash 语法校验全部远端命令：join(' ') 拼接缺分号只在真 shell 暴露
    // （实际发生过 stopInstance 的 fi 后缺分号 → bash -c 整条拒绝执行，mock
    //  全绿——单元测试不解析 shell，语法防线只能靠 bash -n）
    if (process.platform !== 'win32') {
      for (const call of fake.calls) {
        const check = spawnSync('bash', ['-n', '-c', call.command])
        expect(check.status, call.command.slice(0, 80)).toBe(0)
      }
    }
  })

  it('connect：实例未带版本接口（旧插件 404）→ 视为不匹配重启一轮', async () => {
    let startCount = 0
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('echo reuse:')) {
          startCount += 1
          return startCount === 1
            ? { code: 0, stdout: 'reuse:4242\n', stderr: '' }
            : { code: 0, stdout: '', stderr: '' }
        }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      instanceVersion: (attempt) =>
        attempt === 1 ? { ok: false, http: 404 } : { ok: true, dsh: '0.1.7-rc.2', plugin: '0.1.0' },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(fake.calls.some((call) => call.command.includes('ps -p'))).toBe(true)
  })

  it('connect：版本接口非 404 失败（如认证 401）→ 显式报错，不盲目重启', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('echo reuse:')) return { code: 0, stdout: 'reuse:4242\n', stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      instanceVersion: { ok: false, http: 401 },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    expect(engine.stateOf('dev-box').error?.message).toContain('无法确认远端实例版本')
    expect(engine.stateOf('dev-box').error?.message).toContain('401')
    expect(fake.calls.some((call) => call.command.includes('ps -p'))).toBe(false)
  })

  it('connect：重启后版本仍不匹配 → 报错终止，不无限回环', async () => {
    let startCount = 0
    makeEngine({
      localDshVersion: '0.2.0',
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('echo reuse:')) {
          startCount += 1
          return startCount === 1
            ? { code: 0, stdout: 'reuse:4242\n', stderr: '' }
            : { code: 0, stdout: '', stderr: '' }
        }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      instanceVersion: () => ({ ok: true, dsh: '0.1.7-rc.2', plugin: '0.1.0' }),
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    expect(engine.stateOf('dev-box').error?.message).toContain('重启后版本仍不匹配')
    // 只杀过一次（二轮判定失败即终止）
    expect(fake.calls.filter((call) => call.command.includes('ps -p'))).toHaveLength(1)
  })

  it('connect：复用实例健康检查不过 → 视为实例病了，重启自愈一轮', async () => {
    let startCount = 0
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('echo reuse:')) {
          startCount += 1
          return startCount === 1
            ? { code: 0, stdout: 'reuse:4242\n', stderr: '' }
            : { code: 0, stdout: '', stderr: '' }
        }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      // 第一轮 8 次健康检查全不过（旧就绪行还在、实例不应答），第二轮通过
      healthCheck: (attempt) => attempt > 8,
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(fake.calls.some((call) => call.command.includes('ps -p'))).toBe(true)
    // 病实例的转发被丢弃后重建（两次 kill：丢弃 + fail 无关……此处只验证成功）
    expect(engine.stateOf('dev-box').running).toMatchObject({ localPort: 19999 })
  })

  it('save：运行中改基本信息被拒（同步勾选不经 save，直传 startSync）', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      skills: [],
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    // save 只管基本信息：运行中修改（转发进程锚在旧别名上）一律拒绝
    // （save 是 async，BusyError 经 promise rejection 抛出）
    await expect(engine.save(saveRequest({ id: 'dev-box', label: '改名' }))).rejects.toThrow(BusyError)
    await expect(engine.save(saveRequest({ id: 'dev-box', sshAlias: 'other-box' }))).rejects.toThrow(
      BusyError,
    )
    // 同步勾选随 startSync 直传，不受运行态限制
    engine.startSync('dev-box', 'skills', ['alpha'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(engine.stateOf('dev-box').phase).toBe('running')
  })

  it('sync mcp：diff 行写入（手写 id 替换）、same 行跳过；注释保留', async () => {
    makeEngine({
      profilePatch: [
        '- insert:',
        '    - id: mcp-demo',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        transport: stdio',
        '        serverName: demo',
        '        command: node',
        '- insert:',
        '    - id: mcp-same',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        transport: stdio',
        '        serverName: samesrv',
        '        command: npx',
        '- insert:',
        '    - id: mcp-hand',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        transport: stdio',
        '        serverName: hand',
        '        command: new-cmd',
      ].join('\n'),
      respond: (command) => {
        // 远端：demo 配置不同（npx vs 本机 node）、samesrv 完全一致、hand 同名不同 id 不同配置
        if (command.includes('cat ~/.dsh/profiles/web/cordis.patch.yml'))
          return {
            code: 0,
            stdout: `${REMOTE_PATCH}- insert:\n    - id: mcp-same\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: samesrv\n        command: npx\n`,
            stderr: '',
          }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'mcp', ['demo', 'samesrv', 'hand'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const write = fake.calls.find((call) =>
      call.command.includes('cat > ~/.dsh/profiles/web/cordis.patch.yml'),
    )
    expect(write).toBeDefined()
    // 手写注释与未勾选的无关行原样保留
    expect(write?.stdin).toContain('# 远端手写注释')
    // diff 行整块覆盖：demo 换成本机配置；hand 行替换 custom-hand（id 对齐本机）
    expect(write?.stdin).toContain('command: node')
    expect(write?.stdin).toContain('id: mcp-hand')
    expect(write?.stdin).toContain('command: new-cmd')
    expect(write?.stdin).not.toContain('custom-hand')
    expect(engine.stateOf('dev-box').lastSync.mcp).toMatchObject({
      installed: ['mcp-demo', 'mcp-hand'],
      skipped: ['samesrv'],
    })
    expect((await readStore(home)).manifest['dev-box'].mcp).toEqual(['mcp-demo', 'mcp-hand'])
  })

  it('sync mcp：全部一致 → 整次不写盘；取消全部勾选 → 远端零动作', async () => {
    const identical = [
      '- insert:',
      '    - id: mcp-demo',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        transport: stdio',
      '        serverName: demo',
      '        command: npx',
    ].join('\n')
    makeEngine({
      profilePatch: identical,
      respond: (command) => {
        if (command.includes('cat ~/.dsh/profiles/web/cordis.patch.yml'))
          return { code: 0, stdout: identical, stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'mcp', ['demo'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(
      fake.calls.some((call) => call.command.includes('cat > ~/.dsh/profiles/web/cordis.patch.yml')),
    ).toBe(false)
    expect(engine.stateOf('dev-box').lastSync.mcp).toMatchObject({ installed: [], skipped: ['demo'] })

    // 未勾选 = 不动：无任何删除 / 重写（同步永不删远端内容）
    fake.calls.length = 0
    engine.startSync('dev-box', 'mcp', [])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(
      fake.calls.some((call) => call.command.includes('cat > ~/.dsh/profiles/web/cordis.patch.yml')),
    ).toBe(false)
    expect(engine.stateOf('dev-box').lastSync.mcp).toMatchObject({ installed: [], skipped: [] })
  })

  const PLUGIN_PATCH = [
    '- insert:',
    '    - id: dsh-mcp',
    "      name: '@weilence/dsh-mcp'",
    '- insert:',
    '    - id: dsh-skills',
    "      name: '@weilence/dsh-skills'",
  ].join('\n')

  it('sync plugins：本地（link）插件恒打包推送，registry 插件默认远端下载；未勾选不动（不 remove）', async () => {
    makeEngine({
      profilePatch: PLUGIN_PATCH,
      profileDeps: {
        '@weilence/dsh-mcp': 'link:D:/Code/dsh-plugins/plugins/dsh-mcp',
        '@weilence/dsh-skills': '^1.0.0',
      },
      respond: (command) => {
        // 远端 bundles：dsh-skills 已激活（版本 9.9.9），dsh-mcp 未激活
        if (command.startsWith('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout:
              '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@weilence/dsh-remote","@weilence/dsh-skills"]}}}\n',
            stderr: '',
          }
        }
        if (command.startsWith('cd ~/.dsh/profiles/web/node_modules')) {
          return { code: 0, stdout: '@weilence/dsh-skills\t9.9.9\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp', '@weilence/dsh-skills'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const commands = fake.calls.map((call) => call.command)
    // 本地插件：pack + push + add tgz
    expect(fake.packedRoots()).toEqual(['D:/Code/dsh-plugins/plugins/dsh-mcp'])
    expect(fake.filePushes.map((push) => push.fileName)).toEqual(['packed-1.0.0.tgz'])
    expect(commands).toContain(
      'dsh plugin --profile \'web\' add "$HOME/.dsh/dsh-remote/payload/packed-1.0.0.tgz"',
    )
    // registry 插件：本机版本读不到 → 无法比对 → 保守重装（无 scope 包名）
    expect(commands).toContain("dsh plugin --profile 'web' add '@weilence/dsh-skills'")
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: ['@weilence/dsh-mcp', '@weilence/dsh-skills'],
      skipped: [],
    })

    await engine.save(saveRequest({ id: 'dev-box' }))
    fake.calls.length = 0
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    // 未勾选的 dsh-skills 不动：无 remove、无针对它的 add（同步永不删远端内容）
    expect(fake.calls.some((call) => call.command.includes("dsh plugin --profile 'web' remove"))).toBe(false)
    expect(
      fake.calls.some(
        (call) => call.command.includes('@weilence/dsh-skills') && call.command.includes(' add '),
      ),
    ).toBe(false)
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: ['@weilence/dsh-mcp'],
      skipped: [],
    })
  })

  it('sync plugins：registry 插件在 push 选项下也走本地传输', async () => {
    makeEngine({
      profilePatch: PLUGIN_PATCH,
      profileDeps: { '@weilence/dsh-skills': '^1.0.0' },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-skills'], 'push')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    // registry 的包实体定位在层内 node_modules（fixture 假路径下不存在 → 报错可证分流）
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('error')
    expect(state.error?.message).toContain('未能定位 @weilence/dsh-skills 的包目录')
  })

  it('sync plugins：装后清理排除当前 tgz——package.json 的 file: 依赖持续引用它', async () => {
    // 实际事故：清理删掉刚装好的 tgz 后，下一个插件的 add 在重解析 file: 依赖时
    // ENOENT、以退出码 254 失败——payload 不是纯传输介质，当前文件必须保留
    makeEngine({
      profilePatch: PLUGIN_PATCH,
      profileDeps: { '@weilence/dsh-mcp': 'link:D:/Code/dsh-plugins/plugins/dsh-mcp' },
      respond: (command) => {
        if (command.startsWith('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout: '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n',
            stderr: '',
          }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const cleanup = fake.calls.find((call) => call.command.includes('find ~/.dsh/dsh-remote/payload'))
    expect(cleanup).toBeDefined()
    // 只清同包其他版本（版本段锚定数字，不误删相似名包），绝不清刚装上的文件
    expect(cleanup?.command).toContain(`-name 'weilence-dsh-mcp-[0-9]*.tgz'`)
    expect(cleanup?.command).toContain(`! -name 'packed-1.0.0.tgz'`)
  })

  it('sync plugins：安装失败详情合并两路输出并剔除 ssh 横幅——stdout 的真实原因可见', async () => {
    makeEngine({
      profilePatch: PLUGIN_PATCH,
      profileDeps: { '@weilence/dsh-mcp': 'link:D:/Code/dsh-plugins/plugins/dsh-mcp' },
      respond: (command) => {
        // pnpm 的真实错误打在 stdout；stderr 混有本机 ssh 客户端的横幅噪声
        if (command.includes('dsh plugin --profile') && command.includes(' add ')) {
          return {
            code: 254,
            stdout:
              "[ENOENT] ENOENT: no such file or directory, open '.../weilence-dsh-mcp-0.1.0-6a05d7ad.tgz'\nThis error happened while installing a direct dependency of ~/.dsh/profiles/web\n",
            stderr:
              '** This session may be vulnerable to "store now, decrypt later" attacks. **\n** The server may need to be upgraded. See https://openssh.com/pq.html **\ndsh: plugin command failed; diagnostics: /home/x/.plugin-manager/logs/op/pnpm.log\n',
          }
        }
        if (command.startsWith('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout: '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n',
            stderr: '',
          }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const failure = engine.stateOf('dev-box').error
    const message = failure?.message ?? ''
    expect(message).toContain('远端安装 @weilence/dsh-mcp 失败')
    expect(message).toContain('ENOENT')
    expect(message).not.toContain('store now, decrypt later')
    // detail 携带合并两路输出后的完整原文（「查看完整」弹窗的数据源）
    const detail = failure?.detail ?? ''
    expect(detail).toContain('[ENOENT] ENOENT: no such file or directory')
    expect(detail).toContain('dsh: plugin command failed')
    expect(detail).not.toContain('store now, decrypt later')
  })

  it('sync plugins：安装失败输出超长 → detail 保尾部并标明截去的量', async () => {
    makeEngine({
      profilePatch: PLUGIN_PATCH,
      profileDeps: { '@weilence/dsh-mcp': 'link:D:/Code/dsh-plugins/plugins/dsh-mcp' },
      respond: (command) => {
        if (command.includes('dsh plugin --profile') && command.includes(' add ')) {
          return {
            code: 254,
            stdout: `${'x'.repeat(20 * 1024)}\ntail-root-cause\n`,
            stderr: '',
          }
        }
        if (command.startsWith('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout: '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n',
            stderr: '',
          }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const detail = engine.stateOf('dev-box').error?.detail ?? ''
    expect(detail).toContain('tail-root-cause')
    expect(detail).toContain('已截去前 ')
    expect(detail.length).toBeLessThan(20 * 1024 + 200)
  })

  it('sync plugins：本地传输按版本比对——版本不同 → 打包推送', async () => {
    const localPkg = await mkdtemp(join(tmpdir(), 'dsh-remote-plugin-'))
    await writeFile(
      join(localPkg, 'package.json'),
      JSON.stringify({ name: '@weilence/dsh-mcp', version: '0.6.0' }),
      'utf8',
    )
    makeEngine({
      profilePatch: PLUGIN_PATCH,
      profileDeps: {
        '@weilence/dsh-mcp': `link:${localPkg.replaceAll('\\', '/')}`,
      },
      respond: (command) => {
        if (command.startsWith('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout: '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@weilence/dsh-mcp"]}}}\n',
            stderr: '',
          }
        }
        if (command.startsWith('cd ~/.dsh/profiles/web/node_modules')) {
          return { code: 0, stdout: '@weilence/dsh-mcp\t0.5.0\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.packedRoots()).toEqual([localPkg.replaceAll('\\', '/')])
    expect(fake.calls.some((call) => call.command.includes("dsh plugin --profile 'web' add"))).toBe(true)
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: ['@weilence/dsh-mcp'],
      skipped: [],
    })
    await rm(localPkg, { recursive: true, force: true })
  })

  it('sync plugins：registry 插件远端下载按版本比对——版本同即跳过', async () => {
    const layerDir = await mkdtemp(join(tmpdir(), 'dsh-remote-layer-'))
    const entity = join(layerDir, 'node_modules', 'some-registry-plugin')
    await mkdir(entity, { recursive: true })
    await writeFile(
      join(entity, 'package.json'),
      JSON.stringify({ name: 'some-registry-plugin', version: '1.4.2' }),
      'utf8',
    )
    makeEngine({
      layerDir,
      profilePatch: ['- insert:', '    - id: some-plugin', "      name: 'some-registry-plugin'"].join('\n'),
      profileDeps: { 'some-registry-plugin': '^1.4.0' },
      respond: (command) => {
        if (command.startsWith('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout: '{"dsh":{"profile":{"bundles":["some-registry-plugin"]}}}\n',
            stderr: '',
          }
        }
        // 版本同即跳过（npm 语义：版本即内容契约）
        if (command.startsWith('cd ~/.dsh/profiles/web/node_modules')) {
          return { code: 0, stdout: `some-registry-plugin\t1.4.2\n`, stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['some-registry-plugin'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.calls.some((call) => call.command.includes('dsh plugin '))).toBe(false)
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: [],
      skipped: ['some-registry-plugin'],
    })
    await rm(layerDir, { recursive: true, force: true })
  })

  it('sync plugins：本地插件版本同 → 跳过（版本即内容契约，不打包）', async () => {
    const localPkg = await mkdtemp(join(tmpdir(), 'dsh-remote-plugin-'))
    await writeFile(
      join(localPkg, 'package.json'),
      JSON.stringify({ name: '@weilence/dsh-mcp', version: '0.5.0' }),
      'utf8',
    )
    makeEngine({
      profilePatch: PLUGIN_PATCH,
      profileDeps: { '@weilence/dsh-mcp': `link:${localPkg.replaceAll('\\', '/')}` },
      respond: (command) => {
        if (command.startsWith('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout: '{"dsh":{"profile":{"bundles":["@weilence/dsh-mcp"]}}}\n',
            stderr: '',
          }
        }
        if (command.startsWith('cd ~/.dsh/profiles/web/node_modules')) {
          return { code: 0, stdout: '@weilence/dsh-mcp\t0.5.0\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.packedRoots()).toEqual([])
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: [],
      skipped: ['@weilence/dsh-mcp'],
    })
    await rm(localPkg, { recursive: true, force: true })
  })

  it('sync plugins：版本已装但未激活（不在 bundles）→ 重装后恢复激活', async () => {
    const localPkg = await mkdtemp(join(tmpdir(), 'dsh-remote-plugin-'))
    await writeFile(
      join(localPkg, 'package.json'),
      JSON.stringify({ name: '@weilence/dsh-mcp', version: '0.5.0' }),
      'utf8',
    )
    makeEngine({
      profilePatch: PLUGIN_PATCH,
      profileDeps: {
        '@weilence/dsh-mcp': `link:${localPkg.replaceAll('\\', '/')}`,
      },
      respond: (command) => {
        // 远端 bundles 不含 dsh-mcp（node_modules 里装着也不算激活）
        if (command.startsWith('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout: '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n',
            stderr: '',
          }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.packedRoots()).toEqual([localPkg.replaceAll('\\', '/')])
    expect(fake.calls.some((call) => call.command.includes("dsh plugin --profile 'web' add"))).toBe(true)
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: ['@weilence/dsh-mcp'],
      skipped: [],
    })
    await rm(localPkg, { recursive: true, force: true })
  })

  it('sync skills：一致项跳过、不同项推送；未勾选与远端独有零接触（不删除）', async () => {
    makeEngine({
      skills: [
        {
          key: 'user-dsh',
          path: 'C:/skills',
          rows: [
            { name: 'kept', digest: foldSkillDigest([{ path: 'kept/SKILL.md', hash: hex('a') }]) },
            { name: 'other', digest: foldSkillDigest([{ path: 'other/SKILL.md', hash: hex('z') }]) },
          ],
        },
      ],
      respond: (command) => {
        // 远端：kept 内容一致（hash a）、other 内容不同（hash b）、gone 为远端独有
        if (command.startsWith('if cd ~/.dsh/skills')) {
          return {
            code: 0,
            stdout: `${hex('a')}  ./kept/SKILL.md\n${hex('b')}  ./other/SKILL.md\n${hex('c')}  ./gone/SKILL.md\n`,
            stderr: '',
          }
        }
        return undefined
      },
    })
    await writeStore(home, {
      version: 1,
      connections: [
        {
          id: 'dev-box',
          label: '开发机',
          sshAlias: 'dev-box',
          createdAt: '2027-01-01T00:00:00.000Z',
          updatedAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      manifest: {},
    })
    await engine.load()
    engine.startSync('dev-box', 'skills', ['kept', 'other'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    // 一致项 kept 跳过：tar 只打包 other
    expect(fake.tarPushes).toEqual([
      { alias: 'dev-box', localRoot: 'C:/skills', remoteRoot: '~/.dsh/skills', names: ['other'] },
    ])
    // 同步永不删除远端：无 rm，远端独有 / 未勾选条目零接触
    expect(fake.calls.some((call) => call.command.includes('rm -rf'))).toBe(false)
    expect(engine.stateOf('dev-box').lastSync.skills).toMatchObject({ pushed: 1, skipped: 1 })
  })

  it('sync prompts：远端缺文件推送（tmp+mv）、内容一致跳过、未勾选零动作', async () => {
    const content = '# 全局指令\n- 要点\n'
    let remotePrompt = '__ABSENT__\n'
    makeEngine({
      globalPrompt: content,
      respond: (command) => {
        if (command.startsWith('f=~/.dsh/AGENTS.md')) {
          return { code: 0, stdout: remotePrompt, stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())

    // 远端无文件 → 推送（原子写：cat > tmp && mv）
    engine.startSync('dev-box', 'prompts', ['AGENTS.md'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const write = fake.calls.find((call) => call.command.includes('cat > ~/.dsh/AGENTS.md.tmp-dsh-remote'))
    expect(write).toBeDefined()
    expect(write?.stdin).toBe(content)
    expect(engine.stateOf('dev-box').lastSync.prompts).toMatchObject({ pushed: true, skipped: false })
    expect((await readStore(home)).manifest['dev-box'].prompts).toBe(true)

    // 内容一致（远端摘要 = 本机内容 sha256）→ 整次不写盘
    remotePrompt = `${createHash('sha256').update(content, 'utf8').digest('hex')}  /home/u/.dsh/AGENTS.md\n`
    fake.calls.length = 0
    engine.startSync('dev-box', 'prompts', ['AGENTS.md'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.calls.some((call) => call.command.includes('cat > ~/.dsh/AGENTS.md'))).toBe(false)
    expect(engine.stateOf('dev-box').lastSync.prompts).toMatchObject({ pushed: false, skipped: true })

    // 未勾选 = 不动：连远端事实都不取
    fake.calls.length = 0
    engine.startSync('dev-box', 'prompts', [])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.calls.length).toBe(0)
    expect(engine.stateOf('dev-box').lastSync.prompts).toMatchObject({
      pushed: false,
      skipped: false,
    })
  })

  it('sync prompts：本机没有 AGENTS.md → 显式失败', async () => {
    makeEngine({ globalPrompt: null })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'prompts', ['AGENTS.md'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(engine.stateOf('dev-box').phase).toBe('error')
    expect(engine.stateOf('dev-box').error?.message).toContain('本机没有全局提示词')
  })

  it('remoteInventory：四类远端事实（skills 摘要 / MCP 签名 / 插件 bundles+版本 / 提示词摘要）', async () => {
    makeEngine({
      respond: (command) => {
        if (command.startsWith('if cd ~/.dsh/skills'))
          return { code: 0, stdout: `${hex('a')}  ./alpha/SKILL.md\n${hex('b')}  ./beta.md\n`, stderr: '' }
        if (command.startsWith('if cd ~/.agents/skills'))
          return { code: 0, stdout: `${hex('c')}  ./gamma/SKILL.md\n`, stderr: '' }
        if (command.includes('cordis.patch.yml')) return { code: 0, stdout: REMOTE_PATCH, stderr: '' }
        if (command.startsWith('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout: '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@weilence/dsh-remote"]}}}\n',
            stderr: '',
          }
        }
        if (command.startsWith('f=~/.dsh/AGENTS.md')) {
          return { code: 0, stdout: `${hex('d')}  /home/u/.dsh/AGENTS.md\n`, stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    expect(await engine.remoteInventory('dev-box')).toEqual({
      skills: {
        'user-dsh': [
          { name: 'alpha', digest: foldSkillDigest([{ path: 'alpha/SKILL.md', hash: hex('a') }]) },
          { name: 'beta', digest: foldSkillDigest([{ path: 'beta.md', hash: hex('b') }]) },
        ],
        'user-agents': [
          { name: 'gamma', digest: foldSkillDigest([{ path: 'gamma/SKILL.md', hash: hex('c') }]) },
        ],
      },
      mcp: [
        {
          serverName: 'demo',
          signature: mcpSignature({ transport: 'stdio', serverName: 'demo', command: 'npx' }, false),
          summary: 'npx',
        },
        {
          serverName: 'hand',
          signature: mcpSignature({ transport: 'stdio', serverName: 'hand', command: 'old-cmd' }, false),
          summary: 'old-cmd',
        },
      ],
      plugins: [
        { name: '@deepseek-ai/dsh-base', version: null },
        { name: '@weilence/dsh-remote', version: null },
      ],
      prompts: { exists: true, digest: hex('d') },
    })
  })

  it('remoteInventory：patch 语法坏 → mcp null（无法比对）；hasher 缺失 → 该根 null', async () => {
    makeEngine({
      respond: (command) => {
        if (command.startsWith('if cd ~/.dsh/skills'))
          return { code: 0, stdout: '__DSH_NO_HASHER__\n', stderr: '' }
        if (command.includes('cordis.patch.yml')) {
          return { code: 0, stdout: '- insert: [broken\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    const inventory = await engine.remoteInventory('dev-box')
    expect(inventory.skills['user-dsh']).toBeNull()
    expect(inventory.mcp).toBeNull()
  })

  it('互斥：操作在途时第二个操作被拒（409 语义）', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    makeEngine({
      respond: () =>
        new Promise<SshResult>((resolve) => {
          void gate.then(() => resolve(OK))
        }),
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').op !== null)
    expect(() => engine.startSync('dev-box', 'skills', [])).toThrow(BusyError)
    release?.()
    await waitFor(() => engine.stateOf('dev-box').op === null)
  })

  it('remote patch 渲染：upsert 后的文本可直接再解析', async () => {
    const doc = parsePatchDoc(REMOTE_PATCH)
    upsertInsertRow(doc, {
      id: 'mcp-demo',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { transport: 'streamable-http', serverName: 'demo', url: 'https://example/mcp' },
    })
    const text = renderPatchDoc(doc)
    expect(text).toContain('# 远端手写注释')
    expect(parsePatchDoc(text)).toBeDefined()
  })

  it('远端事实脚本：真实子进程跑出 name/version，包缺失版本为空串', async () => {
    // 脚本以字符串内嵌远端执行，fake ssh 测不到它本身——真跑子进程才算数
    const pkgRoot = await mkdtemp(join(tmpdir(), 'dsh-remote-mirror-'))
    await writeFile(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }), 'utf8')
    const absent = join(pkgRoot, 'empty')
    await mkdir(absent)
    const run = spawnSync(process.execPath, ['-e', REMOTE_PLUGIN_FACTS_SCRIPT, pkgRoot, absent], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(`${pkgRoot}\t1.0.0\n${absent}\t\n`)
    await rm(pkgRoot, { recursive: true, force: true })
  })
})
