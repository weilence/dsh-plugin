/**
 * 连接引擎：fake ssh / 转发 / 扫描依赖上的全链集成——save/test/connect
 * （含部署段：环境装配 / tgz 推送 / 版本对比）/disconnect/mcp 下发合并/
 * 插件同步增删/skills 跟踪删除/互斥。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BusyError, RemoteEngine, type EngineDeps } from '../src/engine'
import type { ForwardHandle, SshResult } from '../src/ssh'
import { emptyPatchDoc, parsePatchDoc, renderPatchDoc } from '../src/patchDoc'
import { readStore } from '../src/connections'
import type { LocalPatchLayer } from '../src/localenv'
import type { SaveRequest } from '../src/shared'

interface Recorded {
  alias: string
  command: string
  stdin?: string | Uint8Array
}

const OK: SshResult = { code: 0, stdout: '', stderr: '' }

/** 部署段直通脚本：远端已装齐且版本一致（与 makeDeps 缺省版本对齐）——
 *  连接测试不关心装配细节时前置它，让流程直达启动段。 */
function deployReady(command: string): SshResult | undefined {
  if (command === 'node -v') return { code: 0, stdout: 'v22.19.0\n', stderr: '' }
  if (command === 'npm -v') return { code: 0, stdout: '10.8.2\n', stderr: '' }
  if (command === 'pnpm -v') return { code: 0, stdout: '10.12.0\n', stderr: '' }
  if (command === 'dsh -V') return { code: 0, stdout: '0.1.7-rc.2\n', stderr: '' }
  if (command.includes('node_modules/@weilence/dsh-remote/package.json'))
    return { code: 0, stdout: '{"name":"@weilence/dsh-remote","version":"0.1.0"}\n', stderr: '' }
  if (command.includes('grep -q ')) return { code: 0, stdout: '', stderr: '' }
  return undefined
}

interface FakeOptions {
  /** 按命令文本返回结果；未命中回 OK。抛异常则原样传播。 */
  respond?: (command: string) => SshResult | Promise<SshResult> | undefined
  profilePatch?: string
  homePatch?: string
  /** 层 package.json 的 dependencies（install 形态判定依据）。 */
  profileDeps?: Record<string, string>
  skills?: { key: 'user-dsh' | 'user-agents'; path: string; names: string[] }[]
  tar?: boolean
  /** 本机 dsh 版本（部署对齐目标）；缺省 0.1.7-rc.2。 */
  localDshVersion?: string | null
  /** 本插件版本（部署版本对比目标）；缺省 0.1.0。 */
  localPluginVersion?: string | null
}

function makeDeps(options: FakeOptions = {}) {
  const calls: Recorded[] = []
  const tarPushes: { alias: string; localRoot: string; remoteRoot: string; names?: readonly string[] }[] = []
  const filePushes: { alias: string; localPath: string; remoteDir: string; fileName: string }[] = []
  const packedRoots: string[] = []
  let forwardKilled = 0
  let packCount = 0
  const deps: EngineDeps = {
    async exec(alias, command, execOptions) {
      calls.push({ alias, command, stdin: execOptions?.stdin })
      const scripted = options.respond?.(command)
      if (scripted instanceof Promise) return scripted
      return scripted ?? OK
    },
    startForward(alias, localPort, remotePort): ForwardHandle {
      return {
        kill() {
          forwardKilled += 1
        },
        onExit() {},
      }
    },
    freeLocalPort: async () => 19999,
    healthCheck: async () => true,
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
          file: '/profile/cordis.patch.yml',
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
    tools: { ssh: true, tar: options.tar ?? true },
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
        if (command === 'node -v') return { code: 0, stdout: 'v22.19.0\n', stderr: '' }
        if (command === 'npm -v') return { code: 0, stdout: '10.8.2\n', stderr: '' }
        if (command === 'pnpm -v') return { code: 0, stdout: '10.12.0\n', stderr: '' }
        if (command === 'dsh -V') return { code: 0, stdout: '0.1.7-rc.2\n', stderr: '' }
        // 安装前探查（带 2>/dev/null 后缀）读不到包：未装
        if (command.includes('node_modules/@weilence/dsh-remote/package.json 2>/dev/null')) return OK
        // verify 读回：装上了 0.1.0
        if (command.includes('node_modules/@weilence/dsh-remote/package.json'))
          return { code: 0, stdout: '{"name":"@weilence/dsh-remote","version":"0.1.0"}\n', stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) {
          return { code: 0, stdout: 'dsh web: http://127.0.0.1:4321/?token=tok43\n', stderr: '' }
        }
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
    expect(commands).toContain(
      'dsh plugin --profile \'web\' add "$HOME/.dsh/dsh-remote/payload/weilence-dsh-remote-0.1.0.tgz"',
    )
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
        if (command.includes("grep -m1 '^dsh web: '")) {
          return { code: 0, stdout: 'dsh web: http://127.0.0.1:4321/?token=tok43\n', stderr: '' }
        }
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
        if (command === 'node -v') return { code: 0, stdout: 'v22.19.0\n', stderr: '' }
        if (command === 'npm -v') return { code: 0, stdout: '10.8.2\n', stderr: '' }
        if (command === 'pnpm -v') return { code: 0, stdout: '10.12.0\n', stderr: '' }
        if (command === 'dsh -V') return { code: 0, stdout: '0.1.7-rc.2\n', stderr: '' }
        return undefined // 两次 cat 都空：未装 + 装后读不回
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
        if (command === 'node -v') return { code: 0, stdout: 'v22.19.0\n', stderr: '' }
        if (command === 'npm -v') return { code: 0, stdout: '10.8.2\n', stderr: '' }
        if (command === 'pnpm -v') return { code: 0, stdout: '10.12.0\n', stderr: '' }
        if (command === 'dsh -V') return { code: 0, stdout: '0.1.0\n', stderr: '' }
        if (command.includes('node_modules/@weilence/dsh-remote/package.json'))
          return { code: 0, stdout: '{"name":"@weilence/dsh-remote","version":"0.1.0"}\n', stderr: '' }
        if (command.includes('grep -q ')) return { code: 0, stdout: '', stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) {
          return { code: 0, stdout: 'dsh web: http://127.0.0.1:4321/?token=tok43\n', stderr: '' }
        }
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

  it('connect 部署段：本机版本探测失败（null）→ 直接失败，不退装 latest', async () => {
    makeEngine({
      localDshVersion: null,
      respond: (command) => {
        if (command === 'node -v') return { code: 0, stdout: 'v22.19.0\n', stderr: '' }
        if (command === 'npm -v') return { code: 0, stdout: '10.8.2\n', stderr: '' }
        if (command === 'pnpm -v') return { code: 0, stdout: '10.12.0\n', stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('error')
    expect(state.error?.message).toContain('探测失败')
    // 不得出现任何 npm install（不退装 latest）
    expect(fake.calls.some((call) => call.command.includes('npm install -g'))).toBe(false)
  })

  it('connect 部署段：远端缺 node → error 相位（remote-cmd-failed）', async () => {
    makeEngine({
      respond: (command) => {
        if (command === 'node -v') return { code: 127, stdout: '', stderr: 'bash: node: command not found' }
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

  const REMOTE_PATCH = `# 远端手写注释
- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: demo
        command: npx
`

  it('connect：部署段直通 → start → poll token → forward → health → running（不做顺带同步）', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) {
          return { code: 0, stdout: 'dsh web: http://127.0.0.1:4321/?token=tok43\n', stderr: '' }
        }
        if (command.includes('.pid')) return { code: 0, stdout: '4242\n', stderr: '' }
        return undefined
      },
      skills: [{ key: 'user-dsh', path: 'C:/skills', names: ['alpha', 'beta'] }],
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

  it('connect：远端实例仍存活时复用（不叠加新 nohup 实例）', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes('kill -0')) return { code: 0, stdout: 'reuse:4242\n', stderr: '' }
        if (command.includes("grep -m1 '^dsh web: '")) {
          return { code: 0, stdout: 'dsh web: http://127.0.0.1:4321/?token=tok43\n', stderr: '' }
        }
        if (command.includes('.pid')) return { code: 0, stdout: '4242\n', stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    expect(engine.stateOf('dev-box').running).toMatchObject({ pid: 4242, remotePort: 4321 })
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

  it('disconnect：杀本地转发 + 远端 kill + 回 idle', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) {
          return { code: 0, stdout: 'dsh web: http://127.0.0.1:4321/?token=tok43\n', stderr: '' }
        }
        return undefined
      },
      skills: [],
    })
    await engine.save(saveRequest())
    engine.startConnect('dev-box')
    await waitFor(
      () => engine.stateOf('dev-box').phase === 'running' && engine.stateOf('dev-box').op === null,
    )
    engine.startDisconnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'idle')
    expect(fake.forwardCount()).toBe(1)
    expect(fake.calls.some((call) => call.command.includes('kill "$pid"'))).toBe(true)
    expect(engine.stateOf('dev-box').running).toBeNull()
  })

  it('save：运行中改基本信息被拒（同步勾选不经 save，直传 startSync）', async () => {
    makeEngine({
      respond: (command) => {
        const ready = deployReady(command)
        if (ready !== undefined) return ready
        if (command.includes("grep -m1 '^dsh web: '")) {
          return { code: 0, stdout: 'dsh web: http://127.0.0.1:4321/?token=tok43\n', stderr: '' }
        }
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

  it('sync mcp：合并下发（注释保留）+ 取消勾选后跟踪移除', async () => {
    makeEngine({
      profilePatch: [
        '- insert:',
        '    - id: mcp-demo',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        transport: stdio',
        '        serverName: demo',
        '        command: npx',
      ].join('\n'),
      respond: (command) => {
        if (command.includes('cat ~/.dsh/profiles/web/cordis.patch.yml'))
          return { code: 0, stdout: REMOTE_PATCH, stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'mcp', ['demo'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const write = fake.calls.find((call) =>
      call.command.includes('cat > ~/.dsh/profiles/web/cordis.patch.yml'),
    )
    expect(write).toBeDefined()
    expect(write?.stdin).toContain('# 远端手写注释')
    expect(write?.stdin).toContain('serverName: demo')
    expect(engine.stateOf('dev-box').lastSync.mcp).toMatchObject({ installed: ['mcp-demo'], removed: [] })
    expect((await readStore(home)).manifest['dev-box'].mcp).toEqual(['mcp-demo'])

    // 取消勾选：远端已有但未勾选的行被移除
    await engine.save(saveRequest({ id: 'dev-box' }))
    engine.startSync('dev-box', 'mcp', [])
    await waitFor(
      () => engine.stateOf('dev-box').op === null && engine.stateOf('dev-box').lastSync.mcp !== null,
    )
    const rewrite = [...fake.calls]
      .reverse()
      .find((call) => call.command.includes('cat > ~/.dsh/profiles/web/cordis.patch.yml'))
    expect(rewrite?.stdin).not.toContain('mcp-demo')
    expect(engine.stateOf('dev-box').lastSync.mcp).toMatchObject({ installed: [], removed: ['mcp-demo'] })
  })

  const PLUGIN_PATCH = [
    '- insert:',
    '    - id: dsh-mcp',
    "      name: '@weilence/dsh-mcp'",
    '- insert:',
    '    - id: dsh-skills',
    "      name: '@weilence/dsh-skills'",
  ].join('\n')

  it('sync plugins：本地（link）插件恒打包推送，registry 插件默认远端下载；取消勾选走 remove', async () => {
    makeEngine({
      profilePatch: PLUGIN_PATCH,
      profileDeps: {
        '@weilence/dsh-mcp': 'link:D:/Code/dsh-plugins/plugins/dsh-mcp',
        '@weilence/dsh-skills': '^1.0.0',
      },
      respond: (command) => {
        // 远端 profile 已激活 dsh-skills（含 base / 自身）：取消勾选的移除判定源
        if (command.includes('cat ~/.dsh/profiles/web/package.json')) {
          return {
            code: 0,
            stdout:
              '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@weilence/dsh-remote","@weilence/dsh-skills"]}}}\n',
            stderr: '',
          }
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
    // registry 插件：远端 npm 下载（本机读不到版本时裸名）
    expect(commands).toContain("dsh plugin --profile 'web' add '@weilence/dsh-skills'")
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: ['@weilence/dsh-mcp', '@weilence/dsh-skills'],
      removed: [],
    })

    await engine.save(saveRequest({ id: 'dev-box' }))
    fake.calls.length = 0
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(
      fake.calls.some((call) =>
        call.command.includes("dsh plugin --profile 'web' remove '@weilence/dsh-skills'"),
      ),
    ).toBe(true)
    // dsh-skills 已出清单：不再有任何针对它的安装；dsh-mcp 版本信息不可读
    // （fixture 的 cat 恒空）→ 保守重装一次，属预期
    expect(
      fake.calls.some(
        (call) => call.command.includes('@weilence/dsh-skills') && call.command.includes(' add '),
      ),
    ).toBe(false)
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      removed: ['@weilence/dsh-skills'],
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

  it('sync plugins：远端已装同版本 → 跳过安装（同步幂等）', async () => {
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
        if (command.includes('node_modules/@weilence/dsh-mcp/package.json 2>/dev/null')) {
          return { code: 0, stdout: '{"version":"0.5.0"}\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startSync('dev-box', 'plugins', ['@weilence/dsh-mcp'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(engine.stateOf('dev-box').phase).toBe('idle')
    expect(fake.packedRoots()).toEqual([])
    expect(fake.calls.some((call) => call.command.includes('dsh plugin '))).toBe(false)
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: [],
      removed: [],
    })
    await rm(localPkg, { recursive: true, force: true })
  })

  it('sync skills：按勾选推送；未勾选且远端已有 → 删除；远端独有零接触', async () => {
    makeEngine({
      skills: [{ key: 'user-dsh', path: 'C:/skills', names: ['kept', 'other'] }],
      respond: (command) => {
        // 远端有 kept / other（本机同名）与 gone（远端独有，不在本机清单）
        if (command.startsWith('ls -1 ~/.dsh/skills')) {
          return { code: 0, stdout: 'kept\nother\ngone\n', stderr: '' }
        }
        return undefined
      },
    })
    const { writeStore } = await import('../src/connections')
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
    engine.startSync('dev-box', 'skills', ['kept'])
    await waitFor(() => engine.stateOf('dev-box').op === null)
    // 只打包勾选名：other 不推
    expect(fake.tarPushes).toEqual([
      { alias: 'dev-box', localRoot: 'C:/skills', remoteRoot: '~/.dsh/skills', names: ['kept'] },
    ])
    // 未勾选的本机名 other 在远端存在 → 删除；kept（勾选）与 gone（远端独有）不动
    const remove = fake.calls.find((call) => call.command.startsWith('rm -rf'))
    expect(remove?.command).toContain("~/.dsh/skills/'other'")
    expect(remove?.command).not.toContain('kept')
    expect(remove?.command).not.toContain('gone')
    expect(engine.stateOf('dev-box').lastSync.skills).toMatchObject({ pushed: 1, deleted: 1 })
  })

  it('remoteInventory：三类远端清单（skills 剥 .md / MCP 按 serverName / 插件取 bundles）', async () => {
    makeEngine({
      respond: (command) => {
        if (command.startsWith('ls -1 ~/.dsh/skills'))
          return { code: 0, stdout: 'alpha\nbeta.md\n', stderr: '' }
        if (command.startsWith('ls -1 ~/.agents/skills')) return { code: 0, stdout: 'gamma\n', stderr: '' }
        if (command.includes('cordis.patch.yml')) return { code: 0, stdout: REMOTE_PATCH, stderr: '' }
        if (command.includes('profiles/web/package.json'))
          return {
            code: 0,
            stdout: '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@weilence/dsh-remote"]}}}\n',
            stderr: '',
          }
        return undefined
      },
    })
    await engine.save(saveRequest())
    expect(await engine.remoteInventory('dev-box')).toEqual({
      skills: ['alpha', 'beta', 'gamma'],
      mcp: ['demo'],
      plugins: ['@deepseek-ai/dsh-base', '@weilence/dsh-remote'],
    })
  })

  it('remoteInventory：远端 patch 语法坏 → mcp 按空清单降级，不失败', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes('cordis.patch.yml')) {
          return { code: 0, stdout: '- insert: [broken\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    const inventory = await engine.remoteInventory('dev-box')
    expect(inventory).toEqual({ skills: [], mcp: [], plugins: [] })
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
    const { upsertInsertRow } = await import('../src/patchDoc')
    upsertInsertRow(doc, {
      id: 'mcp-demo',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { transport: 'streamable-http', serverName: 'demo', url: 'https://example/mcp' },
    })
    const text = renderPatchDoc(doc)
    expect(text).toContain('# 远端手写注释')
    expect(parsePatchDoc(text)).toBeDefined()
  })
})
