/**
 * 连接引擎：fake ssh / 转发 / 扫描依赖上的全链集成——save/test/connect
 * （含部署段：环境装配 / tgz 推送 / 版本对比 / 实例版本判定与重启回环）
 * /三类同步（提交即执行：已一致项勾选即强制重推 / 未勾选不动 / 不删除远端）/互斥/删除。
 */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BusyError,
  RemoteEngine,
  REMOTE_PLUGIN_FACTS_SCRIPT,
  SecretRequiredError,
  type EngineDeps,
  type InstanceVersion,
} from '../../src/engine'
import type { ForwardHandle, SshResult, SshTarget } from '../../src/ssh'
import { ForwardRegistry } from '../../src/forwards'
import { emptyPatchDoc, parsePatchDoc } from '../../src/patchDoc'
import { readStore, writeStore } from '../../src/connections'
import { foldSkillDigest, mcpSummary, type LocalPatchLayer, type LocalMcpFile } from '../../src/localenv'
import { mcpSignature, preferredLocalTunnelPort, type SaveRequest } from '../../src/shared'

interface Recorded {
  target: SshTarget
  command: string
  stdin?: string | Uint8Array
}

const OK: SshResult = { code: 0, stdout: '', stderr: '' }

/** 64 位十六进制摘要（远端管线输出行的哈希段形态）。 */
const hex = (char: string): string => char.repeat(64)

/** 部署段直通脚本：远端已装齐且版本一致（与 makeDeps 缺省版本对齐）——
 *  连接测试不关心装配细节时前置它，让流程直达启动段。九项事实一次探查返回。 */
function deployReady(command: string): SshResult | undefined {
  if (command.includes('__NODE__')) {
    return { code: 0, stdout: probeOutput(), stderr: '' }
  }
  return undefined
}

/** 探查输出装配：十项标记行（工具链 + 插件登记 + systemd 服务事实 + 既有单元端口）。
 *  unitPort：null = 单元里读不到端口（首连 / 旧 `--port 0` 单元），缺省与就绪
 *  行的端口一致（4321），让既有用例不产生 port-drift 步骤。 */
function probeOutput(
  options: {
    dsh?: string
    plugin?: string
    registered?: boolean
    dshBin?: string
    unitPort?: number | null
  } = {},
): string {
  const {
    dsh = '0.1.7-rc.2',
    plugin = '{"name":"@weilence/dsh-remote","version":"0.1.0"}',
    registered = true,
    dshBin = '/usr/local/bin/dsh',
    unitPort = 4321,
  } = options
  return (
    `__NODE__v22.19.0\n__NPM__10.8.2\n__PNPM__10.12.0\n__DSH__${dsh}\n` +
    `__PLUGIN__${plugin}\n__REG__${registered ? 1 : 0}\n` +
    `__HOME__/home/u\n__DSHBIN__${dshBin}\n__PATH__/usr/local/bin:/usr/bin:/bin\n` +
    (unitPort === null ? '' : `__UNITPORT__${unitPort}\n`)
  )
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
  /** 本机全局 mcp.json 的 mcpServers 条目（MCP 同步源）。 */
  localMcp?: Record<string, Record<string, unknown>>
  /** profile 层所在目录（registry 包实体定位在层内 node_modules 下）。 */
  layerDir?: string
  /** 层 package.json 的 dependencies（install 形态判定依据）。 */
  profileDeps?: Record<string, string>
  /** 技能扫描结果（name + 内容摘要；同步弹窗「一致」判定的输入）。 */
  skills?: {
    key: 'user-dsh' | 'user-agents'
    path: string
    rows: { name: string; digest: string | null }[]
  }[]
  /** 本机系统提示词（system-prompt.md）内容；缺省 null（本机没有该文件）。 */
  systemPrompt?: string | null
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
  /** 首选隧道口探测结果；缺省 false（首选口按占用处理，走临时端口回退路径——
   *  既有用例的端口断言都钉在 freeLocalPort 的 19999 上）。 */
  probeLocalPort?: (port: number) => boolean
  /** 覆写转发句柄（本地口绑不上的即死句柄等用例）；缺省恒活句柄。 */
  forward?: (localPort: number, attempt: number) => ForwardHandle
  /** 引擎时钟（心跳节流与退避的判定依据）；缺省恒定——心跳用例传可推进的假时钟。 */
  now?: () => string
}

function makeDeps(options: FakeOptions = {}) {
  const calls: Recorded[] = []
  const tarPushes: { target: SshTarget; localRoot: string; remoteRoot: string; names?: readonly string[] }[] =
    []
  const filePushes: { target: SshTarget; localPath: string; remoteDir: string; fileName: string }[] = []
  const forwardCalls: { target: SshTarget; localPort: number; remotePort: number }[] = []
  let forwardAttempt = 0
  const packedRoots: string[] = []
  let forwardKilled = 0
  let packCount = 0
  let versionAttempt = 0
  let healthAttempt = 0
  // 现读口径可变：模拟「本机已升级、宿主未重启」——升级用例里先连接再换新版本
  let currentDsh = options.localDshVersion === undefined ? '0.1.7-rc.2' : options.localDshVersion
  const deps: EngineDeps = {
    async exec(target, command, execOptions) {
      calls.push({ target, command, stdin: execOptions?.stdin })
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
    async startForward(target, localPort, remotePort): Promise<ForwardHandle> {
      forwardCalls.push({ target, localPort, remotePort })
      forwardAttempt += 1
      if (options.forward !== undefined) return options.forward(localPort, forwardAttempt)
      return {
        kill() {
          forwardKilled += 1
        },
        onExit() {},
        pid: 4242,
      }
    },
    probeLocalPort: async (port) => options.probeLocalPort?.(port) ?? false,
    freeLocalPort: async () => 19999,
    async healthCheck() {
      healthAttempt += 1
      return options.healthCheck === undefined ? true : options.healthCheck(healthAttempt)
    },
    async pushTar(target, localRoot, remoteRoot, names) {
      tarPushes.push({ target, localRoot, remoteRoot, names })
    },
    async pushFile(target, localPath, remoteDir, fileName) {
      filePushes.push({ target, localPath, remoteDir, fileName })
    },
    readLocalMcp: async (): Promise<LocalMcpFile> => {
      const entries = new Map(Object.entries(options.localMcp ?? {}))
      return {
        file: '/home/mcp.json',
        rootExtras: {},
        entries,
        rows: [...entries].map(([name, entry]) => ({
          name,
          summary: mcpSummary(entry),
          signature: mcpSignature(entry),
        })),
      }
    },
    readLocalLayers: async () => {
      const docOf = (text: string | undefined) => (text === undefined ? emptyPatchDoc() : parsePatchDoc(text))
      const layers: LocalPatchLayer[] = [
        {
          source: 'profile',
          file: join(options.layerDir ?? '/profile', 'cordis.patch.yml'),
          doc: docOf(options.profilePatch),
          deps: options.profileDeps ?? {},
        },
        {
          source: 'home',
          file: '/home/cordis.patch.yml',
          doc: docOf(options.homePatch),
          deps: {},
        },
      ]
      return layers
    },
    scanSkills: async () => options.skills ?? [],
    readSystemPrompt: async () => options.systemPrompt ?? null,
    currentDshVersion: async () => currentDsh,
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
    now: options.now ?? (() => '2027-01-01T00:00:00.000Z'),
    delay: async () => {},
  }
  return {
    deps,
    calls,
    tarPushes,
    filePushes,
    forwardCalls,
    packedRoots: () => packedRoots,
    forwardCount: () => forwardKilled,
    packCount: () => packCount,
    setCurrentDsh: (version: string | null) => {
      currentDsh = version
    },
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

/** 可推进的假时钟：心跳节流 / 退避都按 deps.now() 判定，测试推进它而不是等真实时间。 */
function fakeClock(startMs = Date.parse('2027-01-01T00:00:00.000Z')) {
  let current = startMs
  return {
    advance: (ms: number) => {
      current += ms
    },
    now: () => new Date(current).toISOString(),
  }
}

function saveRequest(overrides: Partial<SaveRequest> = {}): SaveRequest {
  return {
    label: '开发机',
    target: { kind: 'alias', alias: 'dev-box' },
    rememberSecret: false,
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
    expect(rows[0]).toMatchObject({
      id: 'dev-box',
      target: { kind: 'alias', alias: 'dev-box' },
      secretState: 'none',
      state: { phase: 'idle', op: null },
    })
  })

  it('probe：无状态探针解析三段版本（不占连接操作位、不改阶段）', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('node -v && npm -v')) {
          return { code: 0, stdout: 'v22.19.0\n10.8.2\n0.1.7-rc.2\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    const result = await engine.probe({ target: { kind: 'alias', alias: 'dev-box' } })
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({ nodeVersion: 'v22.19.0', npmVersion: '10.8.2', dshVersion: '0.1.7-rc.2' })
    expect(engine.stateOf('dev-box').phase).toBe('idle')
    // 未保存的目标同样能测（表单新建路径）
    expect((await engine.probe({ target: { kind: 'alias', alias: 'not-saved' } })).ok).toBe(true)
  })

  it('会话口令：不记住时只驻内存（不落盘），重启后需要现场补录', async () => {
    const target = {
      kind: 'direct',
      host: '10.0.0.5',
      port: null,
      user: null,
      auth: 'password',
      identityFile: null,
    } as const
    makeEngine({
      respond: (command) =>
        command.includes('node -v && npm -v')
          ? { code: 0, stdout: 'v22.19.0\n10.8.2\n0.1.7-rc.2\n', stderr: '' }
          : undefined,
    })
    const { id } = await engine.save(saveRequest({ target, secret: 'pw', rememberSecret: false }))
    expect(id).toBe('10-0-0-5')
    expect(engine.rows()[0].secretState).toBe('session')
    const persisted = await readStore(home)
    expect(persisted.connections[0]?.secret).toBeNull()

    // 表单没带口令：靠连接里的会话口令
    await expect(engine.probe({ target })).rejects.toThrow(SecretRequiredError)
    await expect(engine.probe({ id, target })).resolves.toMatchObject({ ok: true })

    // 模拟宿主重启：同一 home 新引擎，内存口令丢失
    const restarted = makeEngine()
    await restarted.load()
    expect(restarted.rows()[0]?.secretState).toBe('none')
    expect(() => restarted.startConnect(id)).toThrow(SecretRequiredError)
    await restarted.setSessionSecret(id, 'pw')
    expect(restarted.rows()[0]?.secretState).toBe('session')
    await expect(restarted.probe({ id, target })).resolves.toMatchObject({ ok: true })
  })

  it('记住口令：写入连接库 0600 文件，重启后仍可用', async () => {
    const target = {
      kind: 'direct',
      host: '10.0.0.5',
      port: 2222,
      user: 'root',
      auth: 'password',
      identityFile: null,
    } as const
    makeEngine()
    const { id } = await engine.save(saveRequest({ target, secret: 'pw', rememberSecret: true }))
    expect(engine.rows()[0]?.secretState).toBe('saved')
    const persisted = await readStore(home)
    expect(persisted.connections[0]?.secret).toBe('pw')

    const restarted = makeEngine()
    await restarted.load()
    expect(restarted.rows()[0]?.secretState).toBe('saved')
    // 重启后仍可用：probe 经 id 取到已落盘的口令
    await expect(restarted.probe({ id, target })).resolves.toMatchObject({ ok: true })
  })

  it('connect 部署段：未装 → 打包推送 tgz 并安装（web profile），verify 读回版本', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('__NODE__')) {
          // 插件未装：PLUGIN 空、REG 0
          return { code: 0, stdout: probeOutput({ plugin: '', registered: false }), stderr: '' }
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
        target: { target: { kind: 'alias', alias: 'dev-box' }, secret: null },
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
          return { code: 0, stdout: probeOutput({ dsh: '0.1.0' }), stderr: '' }
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
    expect(
      fake.calls.some(
        (call) =>
          call.command ===
          'npm install -g \'@deepseek-ai/dsh@0.1.7-rc.2\' && echo __DSHBIN__"$(command -v dsh 2>/dev/null)"',
      ),
    ).toBe(true)
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

  const REMOTE_MCP_JSON = `${JSON.stringify(
    {
      $schema: 'https://dsh.dev/mcp.schema.json',
      mcpServers: {
        demo: { command: 'npx' },
        'remote-only': { command: 'keep-cmd' },
      },
    },
    null,
    2,
  )}\n`

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
      // 机器事实来自部署段探查（与表单「测试」同一组查询），实例身份由版本判定种下
      machine: { node: 'v22.19.0', npm: '10.8.2', dsh: '0.1.7-rc.2' },
      instance: { dsh: '0.1.7-rc.2', plugin: '0.1.0' },
      health: null,
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
      systemPrompt: null,
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )

    engine.startSync('dev-box', 'prompts', ['system-prompt.md'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(engine.stateOf('dev-box')).toMatchObject({
      phase: 'running',
      running: { localPort: 19999 },
      error: { message: expect.stringContaining('本机没有系统提示词') },
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

  it('connect：远端实例仍存活且版本一致时复用（不叠加新实例，单元未变更不 restart）', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('is-active')) return { code: 0, stdout: 'reuse:4242\n', stderr: '' }
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
    // 复用直连：不杀实例（无 stop 命令）、只建一次转发
    expect(fake.calls.some((call) => call.command.includes('systemctl --user stop'))).toBe(false)
    expect(fake.forwardCount()).toBe(0)
  })

  it('connect：启动段写入 systemd 用户单元（stdin 携带单元内容，原料来自探查）', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('is-active')) return { code: 0, stdout: '', stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    const launchCall = fake.calls.find((call) => call.command.includes('is-active'))
    expect(launchCall?.command).toContain('cat > ~/.config/systemd/user/dsh-web.service.tmp-dsh-remote')
    // 单元内容经 stdin：ExecStart 用探查到的 dsh 绝对路径，日志走 append（就绪行解析不变）
    expect(launchCall?.stdin).toContain('[Unit]')
    expect(launchCall?.stdin).toContain('Type=exec')
    expect(launchCall?.stdin).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"')
    expect(launchCall?.stdin).toContain('ExecStart="/usr/local/bin/dsh" --profile web --no-open --port 4321')
    expect(launchCall?.stdin).toContain(`ExecStartPre=/bin/sh -c ': > "/home/u/.dsh/dsh-remote/web.log"'`)
    expect(launchCall?.stdin).toContain('StandardOutput=append:/home/u/.dsh/dsh-remote/web.log')
    expect(launchCall?.stdin).toContain('Restart=on-failure')
    // 单元名、描述与日志路径都不含连接 id：同一台机器换别名连复用同一单元，
    // 内容不变 → cmp 命中 → 不重写、不 restart（只有 pid 文件仍是旧形态的 id 路径）
    expect(launchCall?.stdin).not.toContain('dev-box')
    expect(launchCall?.command).toContain('systemctl --user restart dsh-web.service')
    // 旧 nohup 形态的迁移清理随启动命令一并下发（核验身份后杀，废弃 pid 文件）
    expect(launchCall?.command).toContain('ps -p "$lp" -o command=')
    expect(launchCall?.command).toContain('rm -f ~/.dsh/dsh-remote/dev-box.pid;')
    // enable-linger 是开机自启的前提，每次连接幂等开启并验证
    expect(launchCall?.command).toContain('loginctl enable-linger')
  })

  it('connect：远端没有 systemctl → 显式报错，不回退 nohup', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('is-active')) return { code: 0, stdout: '__NOSYSTEMD__\n', stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    const state = engine.stateOf('dev-box')
    expect(state.error?.kind).toBe('remote-cmd-failed')
    expect(state.error?.message).toContain('systemd 用户服务托管')
    expect(state.error?.message).toContain('systemd ≥ 240')
    // 不发生任何启动尝试与转发
    expect(fake.calls.some((call) => call.command.includes("grep -m1 '^dsh web: '"))).toBe(false)
    expect(fake.forwardCount()).toBe(0)
  })

  it('connect：enable-linger 失败 → 显式报错并带远端原因', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('is-active')) {
          return { code: 0, stdout: '__LINGERFAIL__Not allowed\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    const state = engine.stateOf('dev-box')
    expect(state.error?.message).toContain('enable-linger')
    expect(state.error?.message).toContain('Not allowed')
  })

  it('connect：用户总线不可达 → 显式报错', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('is-active')) {
          return { code: 0, stdout: '__NOBUS__Failed to connect to bus\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    expect(engine.stateOf('dev-box').error?.message).toContain('用户总线')
  })

  it('connect：systemd 启动单元失败 → 显式报错并指路 journal 与日志', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('is-active')) {
          return {
            code: 1,
            stdout: '__STARTFAIL__Job for dsh-web.service failed\n',
            stderr: '',
          }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    const state = engine.stateOf('dev-box')
    expect(state.error?.message).toContain('systemd 启动远端实例失败')
    expect(state.error?.message).toContain('journalctl --user -u dsh-web.service')
  })

  it('connect：远端服务事实探测不全（无 HOME）→ 部署段显式失败', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('__NODE__')) {
          return {
            code: 0,
            stdout: probeOutput().replace('__HOME__/home/u\n', '__HOME__\n'),
            stderr: '',
          }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    const state = engine.stateOf('dev-box')
    expect(state.error?.kind).toBe('remote-cmd-failed')
    expect(state.error?.message).toContain('无法生成 systemd 用户单元')
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
    // ——实例经 /version 自报旧版本，不匹配 → systemctl stop 杀旧（cgroup 整组
    // 收进程 + pid 文件清理 + 日志截断）→ 新启动加载新磁盘 → 二轮判定通过。
    let startCount = 0
    makeEngine({
      localDshVersion: '0.2.0',
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('is-active')) {
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
    const stop = fake.calls.find((call) => call.command.includes('systemctl --user stop'))
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
        if (command.includes('is-active')) {
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
    expect(fake.calls.some((call) => call.command.includes('systemctl --user stop'))).toBe(true)
  })

  it('connect：版本接口非 404 失败（如认证 401）→ 显式报错，不盲目重启', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('is-active')) return { code: 0, stdout: 'reuse:4242\n', stderr: '' }
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
    expect(fake.calls.some((call) => call.command.includes('systemctl --user stop'))).toBe(false)
  })

  it('connect：重启后版本仍不匹配 → 报错终止，不无限回环', async () => {
    let startCount = 0
    makeEngine({
      localDshVersion: '0.2.0',
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('is-active')) {
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
    expect(fake.calls.filter((call) => call.command.includes('systemctl --user stop'))).toHaveLength(1)
  })

  it('connect：复用实例健康检查不过 → 视为实例病了，重启自愈一轮', async () => {
    let startCount = 0
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('is-active')) {
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
    expect(fake.calls.some((call) => call.command.includes('systemctl --user stop'))).toBe(true)
    // 病实例的转发被丢弃后重建（两次 kill：丢弃 + fail 无关……此处只验证成功）
    expect(engine.stateOf('dev-box').running).toMatchObject({ localPort: 19999 })
  })

  it('connect：单元里没有端口（首连 / 旧 --port 0 单元）→ 远端探测空闲端口写进单元', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('__NODE__'))
          return { code: 0, stdout: probeOutput({ unitPort: null }), stderr: '' }
        if (command.includes('node -e ') && command.includes('__PORT__'))
          return { code: 0, stdout: '__PORT__3081\n', stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    const launchCall = fake.calls.find((call) =>
      call.command.includes('cat > ~/.config/systemd/user/dsh-web.service.tmp-dsh-remote'),
    )
    expect(launchCall?.stdin).toContain('--profile web --no-open --port 3081')
    expect(engine.stateOf('dev-box').running).toMatchObject({ remotePort: 4321 })
  })

  it('connect：端口探测无有效输出 → 显式失败（不静默回退随机端口）', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('__NODE__'))
          return { code: 0, stdout: probeOutput({ unitPort: null }), stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    expect(engine.stateOf('dev-box').error?.message).toContain('无法确定实例监听端口')
  })

  it('connect：单元端口与实例实际监听不一致 → 隧道以实际端口为准并记 port-drift', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('__NODE__'))
          return { code: 0, stdout: probeOutput({ unitPort: 3080 }), stderr: '' }
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
    expect(state.running?.remotePort).toBe(4321)
    expect(state.progress?.steps.some((step) => step.step === 'port-drift')).toBe(true)
  })

  it('connect：就绪信号迟迟不出现且日志含 EADDRINUSE → 错误指明端口冲突与出路', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return { code: 1, stdout: '', stderr: '' }
        if (command.includes('tail -n 20'))
          return { code: 0, stdout: 'Error: listen EADDRINUSE :::4321\n', stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    const error = engine.stateOf('dev-box').error
    expect(error?.message).toContain('EADDRINUSE')
    expect(error?.message).toContain('4321')
    expect(error?.message).toContain('dsh-web.service')
  })

  // ───────────────────────── 存活心跳（面板轮询驱动，不建新 ssh） ─────────────────────────

  it('heartbeat：探测健康 → 状态不变、不额外建连', async () => {
    const clock = fakeClock()
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      now: clock.now,
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    const callsBefore = fake.calls.length
    await engine.heartbeat()
    expect(fake.calls.length).toBe(callsBefore)
    clock.advance(10_000)
    await engine.heartbeat()
    expect(fake.calls.length).toBe(callsBefore)
    expect(engine.stateOf('dev-box').running?.health).toBeNull()
  })

  it('heartbeat：每拍顺路问实例自报身份，行上版本实时刷新', async () => {
    const clock = fakeClock()
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      now: clock.now,
      // 连接时的版本判定（attempt 1）与本机一致；心跳的那次（attempt 2）报出
      // 升级后的身份——只刷新展示，不触发任何动作
      instanceVersion: (attempt) =>
        attempt === 1
          ? { ok: true, dsh: '0.1.7-rc.2', plugin: '0.1.0' }
          : { ok: true, dsh: '0.2.0', plugin: '0.2.0' },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(engine.stateOf('dev-box').running?.instance).toEqual({
      dsh: '0.1.7-rc.2',
      plugin: '0.1.0',
    })
    clock.advance(10_000)
    await engine.heartbeat()
    expect(engine.stateOf('dev-box').running?.instance).toEqual({ dsh: '0.2.0', plugin: '0.2.0' })
    expect(engine.stateOf('dev-box').running?.health).toBeNull()
    expect(engine.stateOf('dev-box').phase).toBe('running')
  })

  it('heartbeat：10s 节流 + 连续 2 次失败不核实（判死阈值是 3 次）', async () => {
    const clock = fakeClock()
    let up = true
    let probes = 0
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      now: clock.now,
      healthCheck: () => {
        if (up) return true
        probes += 1
        return false
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    up = false
    await engine.heartbeat()
    expect(probes).toBe(0)
    clock.advance(10_000)
    await engine.heartbeat()
    expect(probes).toBe(1)
    await engine.heartbeat()
    expect(probes).toBe(1)
    clock.advance(10_000)
    await engine.heartbeat()
    expect(probes).toBe(2)
    // 两次失败只是计数，没有核实命令、没有改状态
    expect(engine.stateOf('dev-box').running?.health).toBeNull()
    expect(fake.calls.some((call) => call.command.includes('__ACTIVE__'))).toBe(false)
  })

  it('heartbeat：3 次失败 + systemd active → 无响应（保留 running 与隧道，退避 60s）', async () => {
    const clock = fakeClock()
    let up = true
    let probes = 0
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        if (command.includes('__ACTIVE__')) {
          return {
            code: 0,
            stdout:
              '__ACTIVE__active\n__SUB__running\n__RESTARTS__2\n__LOG__dsh web: http://127.0.0.1:4321/?token=tok43|FATAL|',
            stderr: '',
          }
        }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      now: clock.now,
      healthCheck: () => {
        if (up) return true
        probes += 1
        return false
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    up = false
    for (let i = 0; i < 3; i += 1) {
      clock.advance(10_000)
      await engine.heartbeat()
    }
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('running')
    expect(state.running).not.toBeNull()
    expect(state.running?.health).toMatchObject({ state: 'unresponsive' })
    expect(state.running?.health?.detail).toContain('systemd：active/running')
    expect(state.running?.health?.detail).toContain('FATAL')
    const activeCalls = () => fake.calls.filter((call) => call.command.includes('__ACTIVE__')).length
    expect(activeCalls()).toBe(1)
    // 退避窗口（60s）内继续心跳不探测、不重复核实
    clock.advance(10_000)
    await engine.heartbeat()
    expect(activeCalls()).toBe(1)
    // 窗口过后恢复探测（失败重新从 1 计数，不足 3 次不再核实）
    clock.advance(60_000)
    await engine.heartbeat()
    expect(probes).toBe(4)
    expect(activeCalls()).toBe(1)
  })

  it('heartbeat：systemd activating → 实例重启中（短退避，不动隧道不重启）', async () => {
    const clock = fakeClock()
    let up = true
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('__ACTIVE__'))
          return {
            code: 0,
            stdout: '__ACTIVE__activating\n__SUB__auto-restart\n__RESTARTS__1\n__LOG__|',
            stderr: '',
          }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      now: clock.now,
      healthCheck: () => up,
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    up = false
    const restartsBefore = fake.calls.filter((call) =>
      call.command.includes('systemctl --user restart'),
    ).length
    for (let i = 0; i < 3; i += 1) {
      clock.advance(10_000)
      await engine.heartbeat()
    }
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('running')
    expect(state.running?.health).toMatchObject({ state: 'restarting' })
    expect(fake.calls.filter((call) => call.command.includes('systemctl --user restart')).length).toBe(
      restartsBefore,
    )
  })

  it('heartbeat：systemd inactive → 自动收敛走完整连接流程，成功回 running（op 为 recover）', async () => {
    const clock = fakeClock()
    let alive = true
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('__ACTIVE__'))
          return { code: 0, stdout: '__ACTIVE__inactive\n__SUB__dead\n__RESTARTS__0\n__LOG__|', stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) {
          alive = true
          return launchResult()
        }
        return undefined
      },
      now: clock.now,
      healthCheck: () => alive,
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(fake.calls.filter((call) => call.command.includes('__NODE__')).length).toBe(1)
    alive = false
    for (let i = 0; i < 3; i += 1) {
      clock.advance(10_000)
      await engine.heartbeat()
    }
    // 收敛 = 重跑连接流程（部署段探查再来一遍），不是盲目 systemctl start
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('running')
    expect(state.op).toBeNull()
    expect(state.progress?.kind).toBe('recover')
    expect(state.running).not.toBeNull()
    expect(state.running?.health).toBeNull()
    expect(fake.calls.filter((call) => call.command.includes('__NODE__')).length).toBe(2)
  })

  it('heartbeat：自动恢复失败 → error（progress.kind = recover，面板按「自动恢复失败」取词）', async () => {
    const clock = fakeClock()
    let alive = true
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('__ACTIVE__'))
          return { code: 0, stdout: '__ACTIVE__failed\n__SUB__dead\n__RESTARTS__5\n__LOG__|', stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        return undefined
      },
      now: clock.now,
      healthCheck: () => alive,
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    alive = false
    for (let i = 0; i < 3; i += 1) {
      clock.advance(10_000)
      await engine.heartbeat()
    }
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    const state = engine.stateOf('dev-box')
    expect(state.running).toBeNull()
    expect(state.progress?.kind).toBe('recover')
    expect(state.error?.message).toBeTruthy()
  })

  it('heartbeat：连续掉线超过收敛上限 → 判死停手（不再无限重连）', async () => {
    const clock = fakeClock()
    let alive = true
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('__ACTIVE__'))
          return { code: 0, stdout: '__ACTIVE__inactive\n__SUB__dead\n__RESTARTS__0\n__LOG__|', stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) {
          alive = true
          return launchResult()
        }
        return undefined
      },
      now: clock.now,
      healthCheck: () => alive,
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    // 三轮「死了又收敛成功」：每轮都没有连续两轮健康探测，收敛计数不清零
    for (let episode = 0; episode < 3; episode += 1) {
      alive = false
      for (let i = 0; i < 3; i += 1) {
        clock.advance(10_000)
        await engine.heartbeat()
      }
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
    }
    alive = false
    for (let i = 0; i < 3; i += 1) {
      clock.advance(10_000)
      await engine.heartbeat()
    }
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('error')
    expect(state.running).toBeNull()
    expect(state.error?.message).toContain('自动恢复 3 次')
  })

  it('heartbeat：核实命令 ssh 失败 → 状态未知（不判死、不重启、隧道保留）', async () => {
    const clock = fakeClock()
    let alive = true
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
        if (command.includes('__ACTIVE__')) throw new Error('ssh: connect refused')
        return undefined
      },
      now: clock.now,
      healthCheck: () => alive,
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    const callsBefore = fake.calls.length
    alive = false
    clock.advance(10_000)
    await engine.heartbeat()
    clock.advance(10_000)
    await engine.heartbeat()
    clock.advance(10_000)
    await engine.heartbeat()
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('running')
    expect(state.running?.health).toMatchObject({ state: 'unknown' })
    expect(state.running?.health?.detail).toContain('ssh: connect refused')
    expect(fake.calls.length).toBe(callsBefore + 1)
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
    await expect(
      engine.save(saveRequest({ id: 'dev-box', target: { kind: 'alias', alias: 'other-box' } })),
    ).rejects.toThrow(BusyError)
    // 同步勾选随 startSync 直传，不受运行态限制
    engine.startSync('dev-box', 'skills', ['alpha'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(engine.stateOf('dev-box').phase).toBe('running')
  })

  it('sync mcp：选中条目合并进远端 mcp.json（同名覆盖、远端独有条目与顶层键保留、键序稳定）', async () => {
    makeEngine({
      localMcp: {
        demo: { command: 'node', args: ['server.js'] },
        samesrv: { command: 'npx' },
        hand: { command: 'new-cmd' },
      },
      respond: (command) => {
        // 远端：demo 配置不同（npx vs 本机 node）、samesrv 完全一致、remote-only 远端独有
        if (command.includes('cat ~/.dsh/mcp.json')) return { code: 0, stdout: REMOTE_MCP_JSON, stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'mcp', ['demo', 'samesrv', 'hand'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const write = fake.calls.find((call) => call.command.includes('cat > ~/.dsh/mcp.json'))
    expect(write).toBeDefined()
    const merged = JSON.parse(String(write?.stdin)) as {
      $schema: string
      mcpServers: Record<string, { command: string }>
    }
    // 选中条目全量写入：demo 换成本机配置；samesrv 内容一致也强制重写；hand 新增
    expect(merged.mcpServers.demo).toEqual({ command: 'node', args: ['server.js'] })
    expect(merged.mcpServers.samesrv).toEqual({ command: 'npx' })
    expect(merged.mcpServers.hand).toEqual({ command: 'new-cmd' })
    // 远端独有条目与顶层其他键不动（只新增/覆盖，永不删除）
    expect(merged.mcpServers['remote-only']).toEqual({ command: 'keep-cmd' })
    expect(merged.$schema).toBe('https://dsh.dev/mcp.schema.json')
    // 键序稳定：已有条目原位覆盖、新条目追加在末尾
    expect(Object.keys(merged.mcpServers)).toEqual(['demo', 'remote-only', 'samesrv', 'hand'])
    expect(engine.stateOf('dev-box').lastSync.mcp).toMatchObject({ installed: ['demo', 'samesrv', 'hand'] })
    expect((await readStore(home)).manifest['dev-box'].mcp).toEqual(['demo', 'samesrv', 'hand'])
  })

  it('sync mcp：已一致勾选提交 → 强制重写写盘；取消全部勾选 → 远端零动作；远端文件坏 → 显式中止', async () => {
    const identical = `${JSON.stringify({ mcpServers: { demo: { command: 'npx' } } }, null, 2)}\n`
    makeEngine({
      localMcp: { demo: { command: 'npx' } },
      respond: (command) => {
        if (command.includes('cat ~/.dsh/mcp.json')) return { code: 0, stdout: identical, stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'mcp', ['demo'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    // 勾选已一致条目 = 强制重写：写盘执行（写入幂等）
    expect(fake.calls.some((call) => call.command.includes('cat > ~/.dsh/mcp.json'))).toBe(true)
    expect(engine.stateOf('dev-box').lastSync.mcp).toMatchObject({ installed: ['demo'] })

    // 未勾选 = 不动：远端零接触（同步永不删远端内容）
    fake.calls.length = 0
    engine.startSync('dev-box', 'mcp', [])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.calls.some((call) => call.command.includes('cat > ~/.dsh/mcp.json'))).toBe(false)
    expect(engine.stateOf('dev-box').lastSync.mcp).toMatchObject({ installed: [] })

    // 远端文件解析不了：显式中止，不盲覆盖
    makeEngine({
      localMcp: { demo: { command: 'npx' } },
      respond: (command) => {
        if (command.includes('cat ~/.dsh/mcp.json')) return { code: 0, stdout: '{ broken', stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'mcp', ['demo'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(engine.stateOf('dev-box').phase).toBe('error')
    expect(engine.stateOf('dev-box').error?.message).toContain('解析失败')
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
    // registry 插件：本机版本读不到 → 仍按勾选安装（提交即执行，精确到名字）
    expect(commands).toContain("dsh plugin --profile 'web' add '@weilence/dsh-skills'")
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: ['@weilence/dsh-mcp', '@weilence/dsh-skills'],
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
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.packedRoots()).toEqual([localPkg.replaceAll('\\', '/')])
    expect(fake.calls.some((call) => call.command.includes("dsh plugin --profile 'web' add"))).toBe(true)
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: ['@weilence/dsh-mcp'],
    })
    await rm(localPkg, { recursive: true, force: true })
  })

  it('sync plugins：registry 插件已一致仍按勾选执行（强制重装）', async () => {
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
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['some-registry-plugin'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.calls.some((call) => call.command.includes("add 'some-registry-plugin@1.4.2'"))).toBe(true)
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: ['some-registry-plugin'],
    })
    await rm(layerDir, { recursive: true, force: true })
  })

  it('sync plugins：本地插件已一致仍按勾选强制重推（打包推送）', async () => {
    const localPkg = await mkdtemp(join(tmpdir(), 'dsh-remote-plugin-'))
    await writeFile(
      join(localPkg, 'package.json'),
      JSON.stringify({ name: '@weilence/dsh-mcp', version: '0.5.0' }),
      'utf8',
    )
    makeEngine({
      profilePatch: PLUGIN_PATCH,
      profileDeps: { '@weilence/dsh-mcp': `link:${localPkg.replaceAll('\\', '/')}` },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.packedRoots()).toEqual([localPkg.replaceAll('\\', '/')])
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: ['@weilence/dsh-mcp'],
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
    })
    await rm(localPkg, { recursive: true, force: true })
  })

  it('sync skills：提交即推送（含已一致的强制重推）；未勾选与远端独有零接触（不删除）', async () => {
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
    })
    await writeStore(home, {
      version: 2,
      connections: [
        {
          id: 'dev-box',
          label: '开发机',
          target: { kind: 'alias', alias: 'dev-box' },
          secret: null,
          rememberSecret: false,
          createdAt: '2027-01-01T00:00:00.000Z',
          updatedAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      manifest: {},
    })
    await engine.load()
    engine.startSync('dev-box', 'skills', ['kept', 'other'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    // 提交项全量推送（kept 内容一致也强制重推）
    expect(fake.tarPushes).toEqual([
      {
        target: { target: { kind: 'alias', alias: 'dev-box' }, secret: null },
        localRoot: 'C:/skills',
        remoteRoot: '~/.dsh/skills',
        names: ['kept', 'other'],
      },
    ])
    // 同步永不删除远端：无 rm，远端独有 / 未勾选条目零接触
    expect(fake.calls.some((call) => call.command.includes('rm -rf'))).toBe(false)
    expect(engine.stateOf('dev-box').lastSync.skills).toMatchObject({ pushed: 2 })
  })

  it('sync prompts：远端缺文件推送（tmp+mv）、已一致勾选强制重推、未勾选零动作', async () => {
    const content = '# 全局指令\n- 要点\n'
    makeEngine({ systemPrompt: content })
    await engine.save(saveRequest())

    // 推送（原子写：cat > tmp && mv）
    engine.startSync('dev-box', 'prompts', ['system-prompt.md'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const write = fake.calls.find((call) =>
      call.command.includes('cat > ~/.dsh/system-prompt.md.tmp-dsh-remote'),
    )
    expect(write).toBeDefined()
    expect(write?.stdin).toBe(content)
    expect(engine.stateOf('dev-box').lastSync.prompts).toMatchObject({ pushed: true })
    expect((await readStore(home)).manifest['dev-box'].prompts).toBe(true)

    // 已一致但勾选提交 = 强制重推：仍写盘
    fake.calls.length = 0
    engine.startSync('dev-box', 'prompts', ['system-prompt.md'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.calls.some((call) => call.command.includes('cat > ~/.dsh/system-prompt.md'))).toBe(true)
    expect(engine.stateOf('dev-box').lastSync.prompts).toMatchObject({ pushed: true })

    // 未勾选 = 不动：远端零接触
    fake.calls.length = 0
    engine.startSync('dev-box', 'prompts', [])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(fake.calls.length).toBe(0)
    expect(engine.stateOf('dev-box').lastSync.prompts).toMatchObject({ pushed: false })
  })

  it('sync prompts：本机没有 system-prompt.md → 显式失败', async () => {
    makeEngine({ systemPrompt: null })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'prompts', ['system-prompt.md'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(engine.stateOf('dev-box').phase).toBe('error')
    expect(engine.stateOf('dev-box').error?.message).toContain('本机没有系统提示词')
  })

  it('remoteInventory：四类远端事实（skills 摘要 / MCP 签名 / 插件 bundles+版本 / 提示词摘要）', async () => {
    makeEngine({
      respond: (command) => {
        if (command.startsWith('if cd ~/.dsh/skills'))
          return { code: 0, stdout: `${hex('a')}  ./alpha/SKILL.md\n${hex('b')}  ./beta.md\n`, stderr: '' }
        if (command.startsWith('if cd ~/.agents/skills'))
          return { code: 0, stdout: `${hex('c')}  ./gamma/SKILL.md\n`, stderr: '' }
        if (command.includes('cat ~/.dsh/mcp.json')) return { code: 0, stdout: REMOTE_MCP_JSON, stderr: '' }
        if (command.startsWith('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout: '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@weilence/dsh-remote"]}}}\n',
            stderr: '',
          }
        }
        if (command.startsWith('f=~/.dsh/system-prompt.md')) {
          return { code: 0, stdout: `${hex('d')}  /home/u/.dsh/system-prompt.md\n`, stderr: '' }
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
        { name: 'demo', signature: mcpSignature({ command: 'npx' }), summary: 'npx' },
        { name: 'remote-only', signature: mcpSignature({ command: 'keep-cmd' }), summary: 'keep-cmd' },
      ],
      plugins: [
        { name: '@deepseek-ai/dsh-base', version: null },
        { name: '@weilence/dsh-remote', version: null },
      ],
      prompts: { exists: true, digest: hex('d') },
    })
  })

  it('remoteInventory：mcp.json 结构坏 → mcp null（无法比对）；hasher 缺失 → 该根 null', async () => {
    makeEngine({
      respond: (command) => {
        if (command.startsWith('if cd ~/.dsh/skills'))
          return { code: 0, stdout: '__DSH_NO_HASHER__\n', stderr: '' }
        if (command.includes('cat ~/.dsh/mcp.json')) {
          return { code: 0, stdout: '{ broken json', stderr: '' }
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

  it('远端事实脚本：真实子进程跑出 name/version，包缺失版本为空串', async () => {
    // 脚本以字符串内嵌远端执行，fake ssh 测不到它本身——真跑子进程才算数
    const pkgRoot = await mkdtemp(join(tmpdir(), 'dsh-remote-mirror-'))
    await writeFile(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }), 'utf8')
    const absent = join(pkgRoot, 'empty')
    await mkdir(absent)
    // 剔除本机代理开关：NODE_USE_ENV_PROXY 会让子进程 stderr 带 UNDICI 实验特性
    // 警告，与被测脚本无关；剔除后 stderr 断言只对脚本自身的报错有效
    const env = { ...process.env }
    delete env.NODE_USE_ENV_PROXY
    const run = spawnSync(process.execPath, ['-e', REMOTE_PLUGIN_FACTS_SCRIPT, pkgRoot, absent], {
      encoding: 'utf8',
      env,
    })
    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(`${pkgRoot}\t1.0.0\n${absent}\t\n`)
    await rm(pkgRoot, { recursive: true, force: true })
  })

  describe('版本漂移与手动升级（远端低→升级，本机低→提示不强制）', () => {
    /** 连接并等到 running（部署直通 + 版本一致的缺省编排）。 */
    async function connectToRunning(respond: (command: string) => SshResult | undefined): Promise<void> {
      makeEngine({
        respond: (command) => {
          const ready = deployReady(command)
          if (ready !== undefined) return ready
          if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
          return respond(command)
        },
      })
      await engine.save(saveRequest())
      engine.startConnect('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
    }

    it('connect 部署段：远端 dsh 新于本机 → 不降级（无 npm install），machine 记远端实际版本', async () => {
      makeEngine({
        localDshVersion: '0.1.7-rc.2',
        respond: (command) => {
          if (command.includes('__NODE__')) {
            return { code: 0, stdout: probeOutput({ dsh: '0.3.0' }), stderr: '' }
          }
          if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
          return undefined
        },
        // 实例自报与远端磁盘一致（新于本机）：直接接受，drift = local-behind
        instanceVersion: { ok: true, dsh: '0.3.0', plugin: '0.1.0' },
      })
      await engine.save(saveRequest())
      engine.startConnect('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
      expect(fake.calls.some((call) => call.command.includes('npm install -g'))).toBe(false)
      expect(engine.stateOf('dev-box').running).toMatchObject({
        machine: { dsh: '0.3.0' },
        drift: 'local-behind',
        localDsh: '0.1.7-rc.2',
      })
      const steps = engine.stateOf('dev-box').progress?.steps.map((step) => step.step) ?? []
      expect(steps).toContain('dsh-newer')
      // 接受了较新的运行实例：没有任何 systemctl stop
      expect(fake.calls.some((call) => call.command.includes('systemctl --user stop'))).toBe(false)
    })

    it('connect 部署段：远端 dsh 旧于本机（含 prerelease 序）→ npm 装目标版本', async () => {
      makeEngine({
        localDshVersion: '0.1.7-rc.2',
        respond: (command) => {
          if (command.includes('__NODE__')) {
            // 0.1.7-rc.1 旧于 0.1.7-rc.2（同线 prerelease 逐标识比较）
            return { code: 0, stdout: probeOutput({ dsh: '0.1.7-rc.1' }), stderr: '' }
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
      const install = fake.calls.find((call) => call.command.includes('npm install -g'))
      expect(install?.command).toContain('@deepseek-ai/dsh@0.1.7-rc.2')
    })

    it('connect：实例自报新于本机 + 插件一致 → 不经 stop 收敛直接接受并种下 local-behind', async () => {
      // 部署段远端与本机一致（跳过安装），但活实例是新版本（用户在远端单独升过）
      makeEngine({
        localDshVersion: '0.1.7-rc.2',
        respond: (command) => {
          const ready = deployReady(command)
          if (ready !== undefined) return ready
          if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
          return undefined
        },
        instanceVersion: { ok: true, dsh: '0.2.0', plugin: '0.1.0' },
      })
      await engine.save(saveRequest())
      engine.startConnect('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
      expect(fake.calls.some((call) => call.command.includes('systemctl --user stop'))).toBe(false)
      expect(engine.stateOf('dev-box').running).toMatchObject({ drift: 'local-behind' })
    })

    it('heartbeat：实例自报落后 → drift remote-behind，追平即清空', async () => {
      const clock = fakeClock()
      let reported = '0.1.7-rc.2'
      makeEngine({
        now: clock.now,
        respond: (command) => {
          const ready = deployReady(command)
          if (ready !== undefined) return ready
          if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
          return undefined
        },
        instanceVersion: () => ({ ok: true, dsh: reported, plugin: '0.1.0' }),
      })
      await engine.save(saveRequest())
      engine.startConnect('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
      expect(engine.stateOf('dev-box').running?.drift).toBeNull()
      // 远端被单独改回旧版本并重启（实例自报落后本机）→ 下一拍显形「远端可升级」
      reported = '0.1.7-rc.1'
      clock.advance(10_000)
      await engine.heartbeat()
      expect(engine.stateOf('dev-box').running?.drift).toBe('remote-behind')
      // 追平后清空：漂移是实时结论，不是粘性状态
      reported = '0.1.7-rc.2'
      clock.advance(10_000)
      await engine.heartbeat()
      expect(engine.stateOf('dev-box').running?.drift).toBeNull()
    })

    it('heartbeat：本机现读升级（宿主未重启）→ 下拍显形 remote-behind', async () => {
      const clock = fakeClock()
      makeEngine({
        now: clock.now,
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
      expect(engine.stateOf('dev-box').running?.localDsh).toBe('0.1.7-rc.2')
      // 本机升级 dsh（现读口径立即变新），实例还是旧进程 → 漂移显形
      fake.setCurrentDsh('0.2.0')
      clock.advance(10_000)
      await engine.heartbeat()
      expect(engine.stateOf('dev-box').running?.drift).toBe('remote-behind')
      expect(engine.stateOf('dev-box').running?.localDsh).toBe('0.2.0')
    })

    it('startUpgradeRemote：完整升级流——装新版本、旧实例 stop 收敛、回 running（op=upgrade）', async () => {
      const clock = fakeClock()
      let startCount = 0
      makeEngine({
        now: clock.now,
        respond: (command) => {
          const ready = deployReady(command)
          if (ready !== undefined) return ready
          if (command.includes('is-active')) {
            startCount += 1
            // 前两次 launch（连接 / 升级首查）单元 active 未变 → 复用候选；
            // stop 之后第三次 launch 走全新启动
            return startCount <= 2
              ? { code: 0, stdout: 'reuse:4242\n', stderr: '' }
              : { code: 0, stdout: '', stderr: '' }
          }
          if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
          return undefined
        },
        // 判定次序：连接时自报旧版（一致）→ 升级首查仍是旧进程（不匹配 → stop）
        // → 重启后的新进程自报新版（接受）
        instanceVersion: (attempt) => ({
          ok: true,
          dsh: attempt >= 4 ? '0.2.0' : '0.1.7-rc.2',
          plugin: '0.1.0',
        }),
      })
      await engine.save(saveRequest())
      engine.startConnect('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
      // 本机升级 → 心跳显形「远端可升级」
      fake.setCurrentDsh('0.2.0')
      clock.advance(10_000)
      await engine.heartbeat()
      expect(engine.stateOf('dev-box').running?.drift).toBe('remote-behind')
      engine.startUpgradeRemote('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
      const install = fake.calls.find((call) => call.command.includes('npm install -g'))
      expect(install?.command).toContain('@deepseek-ai/dsh@0.2.0')
      expect(fake.calls.some((call) => call.command.includes('systemctl --user stop'))).toBe(true)
      expect(engine.stateOf('dev-box').running).toMatchObject({
        drift: null,
        localDsh: '0.2.0',
        instance: { dsh: '0.2.0' },
      })
      expect(engine.stateOf('dev-box').progress?.kind).toBe('upgrade')
      expect(engine.stateOf('dev-box').progress?.steps.map((step) => step.step)).toContain('upgrade')
    })

    it('startUpgradeRemote：安装失败 → error（progress.kind = upgrade），不无限回环', async () => {
      await connectToRunning((command) =>
        command.includes('npm install -g') ? { code: 1, stdout: 'npm err', stderr: '' } : undefined,
      )
      fake.setCurrentDsh('0.2.0')
      engine.startUpgradeRemote('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'error' && engine.stateOf('dev-box').op === null,
      )
      expect(engine.stateOf('dev-box').error?.message).toContain('远端安装 @deepseek-ai/dsh 失败')
      expect(engine.stateOf('dev-box').progress?.kind).toBe('upgrade')
    })

    it('startUpgradeRemote：互斥（op 在途拒绝第二个操作）与缺口令（SecretRequiredError）', async () => {
      makeEngine()
      await engine.save(
        saveRequest({
          target: {
            kind: 'direct',
            host: '10.0.0.5',
            port: null,
            user: null,
            auth: 'password',
            identityFile: null,
          },
          secret: 'pw',
          rememberSecret: false,
        }),
      )
      // 模拟宿主重启：同一 home 新引擎，内存口令丢失——升级同连接一样先要口令
      makeEngine()
      await engine.load()
      expect(() => engine.startUpgradeRemote('10-0-0-5')).toThrow(SecretRequiredError)
      // 互斥：op 在途时第二个升级被拒
      await connectToRunning(() => undefined)
      engine.startUpgradeRemote('dev-box')
      expect(() => engine.startUpgradeRemote('dev-box')).toThrow(BusyError)
      await waitFor(() => engine.stateOf('dev-box').op === null)
    })
  })

  describe('本地隧道端口（按 id 推导首选口，占用回退临时口）', () => {
    const PREFERRED = preferredLocalTunnelPort('dev-box')

    /** 即死转发句柄：die() 同步触发 onExit（真实 ssh 绑不上本地口会立即退出；
     *  测试在健康检查回调里调用，避免依赖事件循环次序）。 */
    function dyingForward(): ForwardHandle & { die(): void } {
      let listener: (() => void) | null = null
      return {
        kill() {},
        onExit(callback) {
          listener = callback
        },
        pid: 4242,
        die() {
          listener?.()
        },
      }
    }

    function respondReady(command: string): SshResult | undefined {
      const ready = deployReady(command)
      if (ready !== undefined) return ready
      if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
      return undefined
    }

    it('首选口空闲 → 隧道与租约都落在推导端口上（跨重连 / 宿主重启稳定）', async () => {
      makeEngine({ respond: respondReady, probeLocalPort: () => true })
      await engine.save(saveRequest())
      engine.startConnect('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
      expect(engine.stateOf('dev-box').running).toMatchObject({
        url: `http://127.0.0.1:${PREFERRED}/?token=tok43`,
        localPort: PREFERRED,
      })
      expect(fake.forwardCalls.map((call) => call.localPort)).toEqual([PREFERRED])
      // 租约同样记推导端口：宿主重启后的遗留清扫按它核验命令行
      const leases = JSON.parse(await readFile(join(home, 'dsh-remote', 'forwards.json'), 'utf8')) as Record<
        string,
        { localPort: number }
      >
      expect(leases['dev-box']).toMatchObject({ localPort: PREFERRED })
    })

    it('首选口被占 → 回退内核临时端口', async () => {
      makeEngine({ respond: respondReady })
      await engine.save(saveRequest())
      engine.startConnect('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
      expect(fake.forwardCalls.map((call) => call.localPort)).toEqual([19999])
    })

    it('首选口探测后被竞态抢占（转发进程即死）→ 换临时端口重试一次，回 running', async () => {
      let killFirst: (() => void) | undefined
      makeEngine({
        respond: respondReady,
        probeLocalPort: () => true,
        forward: (_localPort, attempt) => {
          const handle = dyingForward()
          if (attempt === 1) killFirst = handle.die
          return handle
        },
        healthCheck: (attempt) => {
          if (attempt === 1) killFirst?.()
          return attempt > 1
        },
      })
      await engine.save(saveRequest())
      engine.startConnect('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
      expect(fake.forwardCalls.map((call) => call.localPort)).toEqual([PREFERRED, 19999])
      expect(engine.stateOf('dev-box').running).toMatchObject({ localPort: 19999 })
    })

    it('临时口也绑不上 → 显式报错，不重启远端实例（本地问题重启无益）', async () => {
      const deaths: (() => void)[] = []
      makeEngine({
        respond: respondReady,
        probeLocalPort: () => true,
        forward: () => {
          const handle = dyingForward()
          deaths.push(handle.die)
          return handle
        },
        healthCheck: (attempt) => {
          deaths[attempt - 1]?.()
          return false
        },
      })
      await engine.save(saveRequest())
      engine.startConnect('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'error' && engine.stateOf('dev-box').op === null,
      )
      expect(engine.stateOf('dev-box').error?.message).toContain('未能绑定')
      expect(fake.forwardCalls.map((call) => call.localPort)).toEqual([PREFERRED, 19999])
      expect(fake.calls.some((call) => call.command.includes('systemctl --user stop'))).toBe(false)
    })

    it('转发活着但健康检查不过 → 不换口，实例侧问题走复用自愈路径', async () => {
      let startCount = 0
      makeEngine({
        respond: (command) => {
          const ready = deployReady(command)
          if (ready !== undefined) return ready
          if (command.includes('is-active')) {
            startCount += 1
            return startCount === 1
              ? { code: 0, stdout: 'reuse:4242\n', stderr: '' }
              : { code: 0, stdout: '', stderr: '' }
          }
          if (command.includes("grep -m1 '^dsh web: '")) return launchResult()
          return undefined
        },
        probeLocalPort: () => true,
        healthCheck: (attempt) => attempt > 8,
      })
      await engine.save(saveRequest())
      engine.startConnect('dev-box')
      await waitFor(
        () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
      )
      // 两轮 launch 都用首选口：换口重试只属于「进程已死」形态，不吞自愈
      expect(fake.forwardCalls.map((call) => call.localPort)).toEqual([PREFERRED, PREFERRED])
      expect(fake.calls.some((call) => call.command.includes('systemctl --user stop'))).toBe(true)
    })
  })
})
