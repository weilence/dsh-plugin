/**
 * 连接引擎：fake ssh / 转发 / 扫描依赖上的全链集成——save/test/deploy/
 * connect/disconnect/mcp 下发合并/插件同步增删/skills 跟踪删除/互斥。
 */

import { mkdtemp, rm } from 'node:fs/promises'
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
  stdin?: string
}

const OK: SshResult = { code: 0, stdout: '', stderr: '' }

interface FakeOptions {
  /** 按命令文本返回结果；未命中回 OK。抛异常则原样传播。 */
  respond?: (command: string) => SshResult | Promise<SshResult> | undefined
  profilePatch?: string
  homePatch?: string
  skills?: { key: string; path: string; names: string[] }[]
  tar?: boolean
  /** 本机 dsh 版本（部署对齐目标）；缺省 0.1.7-rc.2。 */
  localDshVersion?: string | null
}

function makeDeps(options: FakeOptions = {}) {
  const calls: Recorded[] = []
  const tarPushes: { alias: string; localRoot: string; remoteRoot: string }[] = []
  let forwardKilled = 0
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
    async pushTar(alias, localRoot, remoteRoot) {
      tarPushes.push({ alias, localRoot, remoteRoot })
    },
    readLocalLayers: async () => {
      const layers: LocalPatchLayer[] = [
        {
          source: 'profile',
          file: '/profile/cordis.patch.yml',
          doc: options.profilePatch === undefined ? emptyPatchDoc() : parsePatchDoc(options.profilePatch),
        },
        {
          source: 'home',
          file: '/home/cordis.patch.yml',
          doc: options.homePatch === undefined ? emptyPatchDoc() : parsePatchDoc(options.homePatch),
        },
      ]
      return layers
    },
    scanSkills: async () => options.skills ?? [],
    tools: { ssh: true, tar: options.tar ?? true },
    localDshVersion: options.localDshVersion === undefined ? '0.1.7-rc.2' : options.localDshVersion,
    homeDir: '',
    now: () => '2027-01-01T00:00:00.000Z',
    delay: async () => {},
  }
  return { deps, calls, tarPushes, forwardCount: () => forwardKilled }
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
    sync: { mcpServerNames: [], pluginNames: [] },
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

  it('deploy：node/npm/pnpm 探针 → dsh 版本与本机一致跳过 → 只装 dsh-remote 插件（web profile）', async () => {
    makeEngine({
      respond: (command) => {
        if (command === 'node -v') return { code: 0, stdout: 'v22.19.0\n', stderr: '' }
        if (command === 'npm -v') return { code: 0, stdout: '10.8.2\n', stderr: '' }
        if (command === 'pnpm -v') return { code: 0, stdout: '10.12.0\n', stderr: '' }
        if (command === 'dsh -V') return { code: 0, stdout: '0.1.7-rc.2\n', stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startDeploy('dev-box')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const state = engine.stateOf('dev-box')
    expect(state.phase).toBe('idle')
    expect(state.error).toBeNull()
    const commands = fake.calls.map((call) => call.command)
    expect(commands).toContain("dsh plugin --profile 'web' add 'dsh-remote'")
    expect(commands.some((command) => command.includes('npm install -g'))).toBe(false)
  })

  it('deploy：远端 dsh 版本与本机不一致 → npm 装对齐版本', async () => {
    makeEngine({
      respond: (command) => {
        if (command === 'node -v') return { code: 0, stdout: 'v22.19.0\n', stderr: '' }
        if (command === 'npm -v') return { code: 0, stdout: '10.8.2\n', stderr: '' }
        if (command === 'pnpm -v') return { code: 0, stdout: '10.12.0\n', stderr: '' }
        if (command === 'dsh -V') return { code: 0, stdout: '0.1.0\n', stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startDeploy('dev-box')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(engine.stateOf('dev-box').phase).toBe('idle')
    expect(fake.calls.some((call) => call.command === "npm install -g '@deepseek-ai/dsh@0.1.7-rc.2'")).toBe(
      true,
    )
  })

  it('deploy：本机版本未知（null）→ 远端装 latest', async () => {
    let dshProbeCount = 0
    makeEngine({
      localDshVersion: null,
      respond: (command) => {
        if (command === 'node -v') return { code: 0, stdout: 'v22.19.0\n', stderr: '' }
        if (command === 'npm -v') return { code: 0, stdout: '10.8.2\n', stderr: '' }
        if (command === 'pnpm -v') return { code: 0, stdout: '10.12.0\n', stderr: '' }
        // 第一次 dsh -V（安装前检查）失败；npm install 后的验证探针成功
        if (command === 'dsh -V') {
          dshProbeCount += 1
          return dshProbeCount === 1
            ? { code: 1, stdout: '', stderr: 'not found' }
            : { code: 0, stdout: '0.2.0\n', stderr: '' }
        }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startDeploy('dev-box')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(engine.stateOf('dev-box').phase).toBe('idle')
    expect(fake.calls.some((call) => call.command === "npm install -g '@deepseek-ai/dsh'")).toBe(true)
  })

  it('deploy：远端缺 node → error 相位（remote-cmd-failed）', async () => {
    makeEngine({
      respond: (command) => {
        if (command === 'node -v') return { code: 127, stdout: '', stderr: 'bash: node: command not found' }
        return undefined
      },
    })
    await engine.save(saveRequest())
    engine.startDeploy('dev-box')
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

  it('connect：start → poll token → forward → health → running（不做顺带同步）', async () => {
    makeEngine({
      respond: (command) => {
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
        if (command.includes("grep -m1 '^dsh web: '")) return OK
        if (command.includes('tail -n 20')) return { code: 0, stdout: 'boom\nboom\n', stderr: '' }
        return undefined
      },
    })
    await engine.save(saveRequest({ sync: { mcpServerNames: [], pluginNames: [] } }))
    engine.startConnect('dev-box')
    await waitFor(() => engine.stateOf('dev-box').phase === 'error')
    const state = engine.stateOf('dev-box')
    expect(state.error?.kind).toBe('timeout')
    expect(state.error?.message).toContain('boom')
  })

  it('disconnect：杀本地转发 + 远端 kill + 回 idle', async () => {
    makeEngine({
      respond: (command) => {
        if (command.includes("grep -m1 '^dsh web: '")) {
          return { code: 0, stdout: 'dsh web: http://127.0.0.1:4321/?token=tok43\n', stderr: '' }
        }
        return undefined
      },
      skills: [],
    })
    await engine.save(saveRequest({ sync: { mcpServerNames: [], pluginNames: [] } }))
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
    await engine.save(saveRequest({ sync: { mcpServerNames: ['demo'], pluginNames: [] } }))
    engine.startSync('dev-box', 'mcp')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const write = fake.calls.find((call) =>
      call.command.includes('cat > ~/.dsh/profiles/web/cordis.patch.yml'),
    )
    expect(write).toBeDefined()
    expect(write?.stdin).toContain('# 远端手写注释')
    expect(write?.stdin).toContain('serverName: demo')
    expect(engine.stateOf('dev-box').lastSync.mcp).toMatchObject({ installed: ['mcp-demo'], removed: [] })
    expect((await readStore(home)).manifest['dev-box'].mcp).toEqual(['mcp-demo'])

    // 取消勾选：manifest 里的行被移除
    await engine.save(saveRequest({ id: 'dev-box', sync: { mcpServerNames: [], pluginNames: [] } }))
    engine.startSync('dev-box', 'mcp')
    await waitFor(
      () => engine.stateOf('dev-box').op === null && engine.stateOf('dev-box').lastSync.mcp !== null,
    )
    const rewrite = [...fake.calls]
      .reverse()
      .find((call) => call.command.includes('cat > ~/.dsh/profiles/web/cordis.patch.yml'))
    expect(rewrite?.stdin).not.toContain('mcp-demo')
    expect(engine.stateOf('dev-box').lastSync.mcp).toMatchObject({ installed: [], removed: ['mcp-demo'] })
  })

  it('sync plugins：新勾选走 add，取消勾选走 remove（远端默认基线 dsh-remote 不可移除）', async () => {
    makeEngine({
      profilePatch: [
        '- insert:',
        '    - id: dsh-mcp',
        "      name: 'dsh-mcp'",
        '- insert:',
        '    - id: dsh-skills',
        "      name: 'dsh-skills'",
      ].join('\n'),
    })
    await engine.save(saveRequest({ sync: { mcpServerNames: [], pluginNames: ['dsh-mcp', 'dsh-skills'] } }))
    engine.startSync('dev-box', 'plugins')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(
      fake.calls.some((call) =>
        call.command.includes("dsh plugin --profile 'web' add 'dsh-mcp' 'dsh-skills'"),
      ),
    ).toBe(true)
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: ['dsh-mcp', 'dsh-skills'],
      removed: [],
    })

    await engine.save(saveRequest({ id: 'dev-box', sync: { mcpServerNames: [], pluginNames: ['dsh-mcp'] } }))
    fake.calls.length = 0
    engine.startSync('dev-box', 'plugins')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    expect(
      fake.calls.some((call) => call.command.includes("dsh plugin --profile 'web' remove 'dsh-skills'")),
    ).toBe(true)
    expect(engine.stateOf('dev-box').lastSync.plugins).toMatchObject({
      installed: [],
      removed: ['dsh-skills'],
    })
  })

  it('sync skills：跟踪式删除只清 manifest 记录过的名字', async () => {
    makeEngine({ skills: [{ key: 'user-dsh', path: 'C:/skills', names: ['kept'] }] })
    const { writeStore } = await import('../src/connections')
    await writeStore(home, {
      version: 1,
      connections: [
        {
          id: 'dev-box',
          label: '开发机',
          sshAlias: 'dev-box',
          sync: { mcpServerNames: [], pluginNames: [] },
          createdAt: '2027-01-01T00:00:00.000Z',
          updatedAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      manifest: { 'dev-box': { skills: { 'user-dsh': ['kept', 'gone'] }, mcp: [], plugins: [] } },
    })
    await engine.load()
    engine.startSync('dev-box', 'skills')
    await waitFor(() => engine.stateOf('dev-box').op === null)
    const remove = fake.calls.find((call) => call.command.startsWith('rm -rf'))
    expect(remove?.command).toContain("~/.dsh/skills/'gone'")
    expect(remove?.command).not.toContain('kept')
    expect(engine.stateOf('dev-box').lastSync.skills).toMatchObject({ pushed: 1, deleted: 1 })
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
    engine.startDeploy('dev-box')
    await waitFor(() => engine.stateOf('dev-box').op !== null)
    expect(() => engine.startConnect('dev-box')).toThrow(BusyError)
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
