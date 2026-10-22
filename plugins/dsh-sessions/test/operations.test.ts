import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompress } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@dsh-plugins/shared/http'
import { runBatch } from '../src/batch'
import { deleteSessionCascade } from '../src/delete'
import { migrateSession } from '../src/move'
import { migratePreset } from '../src/preset'
import { encodeIdSegment, encodeProjectKey, readSessionArtifactFile } from '../src/surgery'

const compress = promisify(zstdCompress)

interface WorkspaceFake {
  id: string
  path: string
  sessionIds: string[]
  attachSession: ReturnType<typeof vi.fn>
  detachSession: ReturnType<typeof vi.fn>
}

interface Fixture {
  ctx: Context
  stored: Map<string, { header: Record<string, unknown>; formatStatus?: 'current' | 'migration-required' }>
  live: Set<string>
  activity: Map<string, unknown[]>
  registry: {
    get: ReturnType<typeof vi.fn>
    list: () => WorkspaceFake[]
    unarchiveSession: ReturnType<typeof vi.fn>
    headers?: Map<string, unknown>
    sessionPaths?: Map<string, string>
    missingSessionPaths?: Set<string>
    invalidSessionPaths?: Map<string, unknown>
  }
}

function headerOf(id: string, cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
    cwd,
    ...extra,
  }
}

function eventLine(type: string, data: Record<string, unknown>, seq: number): string {
  return JSON.stringify({ type, seq, time: 1000 + seq, data })
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )

/**
 * 假宿主：stat/list 只报磁盘上真实存在的工件；attachSession 模拟官方「缓存优先」
 * 的 cwd 强校验——有头缓存时读缓存，没有时退到存储头。
 */
function makeFixture(withCache: boolean): Fixture {
  const stored = new Map<
    string,
    { header: Record<string, unknown>; formatStatus?: 'current' | 'migration-required' }
  >()
  const live = new Set<string>()
  const activity = new Map<string, unknown[]>()
  const entities: WorkspaceFake[] = []
  const registry: Fixture['registry'] = {
    get: vi.fn((id: string) => entities.find((entity) => entity.id === id)),
    list: () => entities,
    unarchiveSession: vi.fn(async () => {}),
  }
  if (withCache) {
    registry.headers = new Map()
    registry.sessionPaths = new Map()
    registry.missingSessionPaths = new Set()
    registry.invalidSessionPaths = new Map()
  }
  const presets = { list: vi.fn(async () => [{ id: 'coder' }, { id: 'writer' }]) }
  const ctx = {
    sessions: { get: (id: string) => (live.has(id) ? { id } : undefined) },
    sessionPersistence: {
      stat: vi.fn(async (id: string) => stored.get(id)),
      list: vi.fn(async () => [...stored.values()].map((entry) => ({ header: entry.header }))),
      open: vi.fn(async (id: string) => {
        throw new SessionAlreadyOwnedError(id as never)
      }),
    },
    workspaceRegistry: registry,
    waterfall: vi.fn(
      async (_name: string, payload: { sessionId: string }, next: () => Promise<unknown[]>) =>
        activity.get(payload.sessionId) ?? (await next()),
    ),
    get: (name: string) => (name === 'agentPresets' ? presets : undefined),
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as Context
  return { ctx, stored, live, activity, registry }
}

async function writeArtifact(
  root: string,
  id: string,
  cwd: string,
  bodyLines: readonly string[],
  zstd: boolean,
): Promise<void> {
  const dir = join(root, encodeProjectKey(cwd), encodeIdSegment(id))
  await mkdir(dir, { recursive: true })
  const headerText = JSON.stringify(headerOf(id, cwd))
  const filename = zstd ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl'
  const body = bodyLines.length === 0 ? '' : `${bodyLines.join('\n')}\n`
  const bytes = zstd
    ? Buffer.concat([
        await compress(Buffer.from(`${headerText}\n`)),
        ...(body === '' ? [] : [await compress(Buffer.from(body))]),
      ])
    : Buffer.from(`${headerText}\n${body}`)
  await writeFile(join(dir, filename), bytes)
}

function workspaceEntity(fixture: Fixture, id: string, canonicalPath: string): WorkspaceFake {
  const entity: WorkspaceFake = {
    id,
    path: canonicalPath,
    sessionIds: [],
    attachSession: vi.fn(async (sessionId: string) => {
      if (!entity.sessionIds.includes(sessionId)) {
        const cached = fixture.registry.sessionPaths?.get(sessionId)
        const header = fixture.stored.get(sessionId)?.header
        const cwd = cached ?? (typeof header?.cwd === 'string' ? header.cwd : undefined)
        if (cwd === undefined) throw new Error('会话没有可校验的 cwd')
        if ((await realpath(cwd)) !== entity.path) {
          throw new Error(`其 cwd 解析到 '${cwd}'`)
        }
        entity.sessionIds = [sessionId, ...entity.sessionIds]
      }
    }),
    detachSession: vi.fn(async (sessionId: string) => {
      entity.sessionIds = entity.sessionIds.filter((candidate) => candidate !== sessionId)
    }),
  }
  return entity
}

describe.each([false, true])('级联删除（zstd=%s）', (zstd) => {
  let f: Fixture
  let root: string
  let oldCwd: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-sessions-delete-'))
    oldCwd = join(root, 'old-ws')
    await mkdir(oldCwd)
    f = makeFixture(true)
    ;(f.stored as unknown as { __root?: string }).__root = root
    await writeArtifact(root, 'root', oldCwd, [eventLine('user/message', {}, 0)], zstd)
    await writeArtifact(root, 'child1', oldCwd, [], zstd)
    await writeArtifact(root, 'child1a', oldCwd, [], zstd)
    await writeArtifact(root, 'other', oldCwd, [eventLine('user/message', {}, 0)], zstd)
    f.stored.set('root', { header: headerOf('root', oldCwd), formatStatus: 'current' })
    f.stored.set('child1', {
      header: headerOf('child1', oldCwd, { origin: 'subagent', parentSession: 'root' }),
    })
    f.stored.set('child1a', {
      header: headerOf('child1a', oldCwd, { origin: 'subagent', parentSession: 'child1' }),
    })
    f.stored.set('other', { header: headerOf('other', oldCwd), formatStatus: 'current' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('后代逆序级联删除，无关会话保留、账本与归档条目清理', async () => {
    const result = await deleteSessionCascade(f.ctx, root, 'root')
    expect(result).toEqual({
      filesRemoved: true,
      archiveCleared: true,
      deletedSubagents: ['child1a', 'child1'],
    })
    for (const id of ['root', 'child1', 'child1a']) {
      await expect(exists(join(root, encodeProjectKey(oldCwd), encodeIdSegment(id)))).resolves.toBe(false)
    }
    await expect(exists(join(root, encodeProjectKey(oldCwd), encodeIdSegment('other')))).resolves.toBe(true)
    expect(f.registry.unarchiveSession).toHaveBeenCalledTimes(3)
  })

  it('谱系扫描失败即拒绝，不动任何文件', async () => {
    ;(f.ctx.sessionPersistence.list as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('disk offline'),
    )
    await expect(deleteSessionCascade(f.ctx, root, 'root')).rejects.toThrow('disk offline')
    await expect(exists(join(root, encodeProjectKey(oldCwd), encodeIdSegment('root')))).resolves.toBe(true)
  })

  it('任一后代已加载或活跃即整体拒绝', async () => {
    f.live.add('child1')
    await expect(deleteSessionCascade(f.ctx, root, 'root')).rejects.toThrow('仍加载在宿主内存中')
    f.live.delete('child1')
    f.activity.set('child1a', [{ kind: 'turn' }])
    await expect(deleteSessionCascade(f.ctx, root, 'root')).rejects.toThrow('仍有进行中的活动')
    await expect(exists(join(root, encodeProjectKey(oldCwd), encodeIdSegment('child1a')))).resolves.toBe(true)
  })

  it('无效会话 id 拒绝', async () => {
    await expect(deleteSessionCascade(f.ctx, root, '../escape')).rejects.toThrow(HttpError)
  })
})

describe.each([false, true])('原地迁移（zstd=%s）', (zstd) => {
  let f: Fixture
  let root: string
  let oldCwd: string
  let newCwd: string
  let target: WorkspaceFake
  let old: WorkspaceFake

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-sessions-move-'))
    await mkdir(join(root, 'old-ws'))
    await mkdir(join(root, 'new-ws'))
    oldCwd = await realpath(join(root, 'old-ws'))
    newCwd = await realpath(join(root, 'new-ws'))
    f = makeFixture(true)
    ;(f.stored as unknown as { __root?: string }).__root = root
    await writeArtifact(
      root,
      'root',
      oldCwd,
      [eventLine('user/message', {}, 0), eventLine('agent-preset/selected', { agentPreset: 'coder' }, 1)],
      zstd,
    )
    f.stored.set('root', { header: headerOf('root', oldCwd), formatStatus: 'current' })
    target = workspaceEntity(f, 'ws-new', newCwd)
    old = workspaceEntity(f, 'ws-old', oldCwd)
    old.sessionIds = ['root']
    ;(f.registry.list as unknown as () => WorkspaceFake[]) = () => [old, target]
    f.registry.get = vi.fn((id: string) => [old, target].find((entity) => entity.id === id))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const artifactDir = (cwd: string): string => join(root, encodeProjectKey(cwd), encodeIdSegment('root'))
  const artifactPath = (cwd: string): string =>
    join(artifactDir(cwd), zstd ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl')

  it('快路径：cwd 已等于目标路径时只补账本，不动文件', async () => {
    f.stored.set('root', { header: headerOf('root', newCwd), formatStatus: 'current' })
    const result = await migrateSession(f.ctx, root, { sessionId: 'root', workspaceId: 'ws-new' })
    expect(result).toEqual({ ok: true, moved: false, attached: true })
    expect(target.sessionIds).toContain('root')
    await expect(exists(artifactDir(oldCwd))).resolves.toBe(true)
  })

  it('手术路径：文件移动到新项目目录，头部改写、事件逐字节保留并补账本', async () => {
    const result = await migrateSession(f.ctx, root, { sessionId: 'root', workspaceId: 'ws-new' })
    expect(result).toEqual({ ok: true, moved: true, attached: true })
    const artifact = await readSessionArtifactFile(artifactPath(newCwd), zstd)
    expect(artifact.header.cwd).toBe(newCwd)
    expect(artifact.bodyText).toBe(
      `${eventLine('user/message', {}, 0)}\n${eventLine('agent-preset/selected', { agentPreset: 'coder' }, 1)}\n`,
    )
    await expect(exists(artifactDir(oldCwd))).resolves.toBe(false)
    expect(f.registry.sessionPaths?.get('root')).toBe(newCwd)
    expect(target.sessionIds).toContain('root')
    expect(old.sessionIds).not.toContain('root')
  })

  it('日志已有工作目录历史时补记 change 事件', async () => {
    await rm(artifactDir(oldCwd), { recursive: true })
    await writeArtifact(
      root,
      'root',
      oldCwd,
      [eventLine('working-directory/change', { cwd: oldCwd }, 0), eventLine('user/message', {}, 1)],
      zstd,
    )
    await migrateSession(f.ctx, root, { sessionId: 'root', workspaceId: 'ws-new' })
    const artifact = await readSessionArtifactFile(artifactPath(newCwd), zstd)
    const lines = artifact.bodyText.trimEnd().split('\n')
    const appended = JSON.parse(lines.at(-1)!) as { type: string; seq: number; data: { cwd: string } }
    expect(appended).toMatchObject({ type: 'working-directory/change', seq: 2 })
    expect(appended.data.cwd).toBe(newCwd)
  })

  it('注册表不支持在线补挂时报告 membershipPending，不调 attach', async () => {
    const bare = makeFixture(false)
    ;(bare.stored as unknown as { __root?: string }).__root = root
    bare.stored.set('root', { header: headerOf('root', oldCwd), formatStatus: 'current' })
    const bareTarget = workspaceEntity(bare, 'ws-new', newCwd)
    ;(bare.registry.list as unknown as () => WorkspaceFake[]) = () => [bareTarget]
    bare.registry.get = vi.fn(() => bareTarget)
    const result = await migrateSession(bare.ctx, root, { sessionId: 'root', workspaceId: 'ws-new' })
    expect(result.moved).toBe(true)
    expect(result.attached).toBe(false)
    expect(result.membershipPending).toContain('归入目标工作区失败')
    expect(bareTarget.attachSession).not.toHaveBeenCalled()
  })

  it('已加载或活跃即拒绝，文件不动', async () => {
    f.live.add('root')
    await expect(migrateSession(f.ctx, root, { sessionId: 'root', workspaceId: 'ws-new' })).rejects.toThrow(
      '仍加载在宿主内存中',
    )
    f.live.delete('root')
    f.activity.set('root', [{ kind: 'turn' }])
    await expect(migrateSession(f.ctx, root, { sessionId: 'root', workspaceId: 'ws-new' })).rejects.toThrow(
      '仍有进行中的活动',
    )
    await expect(exists(artifactDir(oldCwd))).resolves.toBe(true)
  })

  it('目标位置已有工件时拒绝：同 id 出现在多个项目目录即拒绝操作', async () => {
    await writeArtifact(root, 'root', newCwd, [], zstd)
    await expect(migrateSession(f.ctx, root, { sessionId: 'root', workspaceId: 'ws-new' })).rejects.toThrow(
      '同时出现在多个项目目录',
    )
  })

  it('subagent 与旧代格式拒绝迁移', async () => {
    await writeArtifact(root, 'sub', oldCwd, [], zstd)
    f.stored.set('sub', {
      header: headerOf('sub', oldCwd, { origin: 'subagent', parentSession: 'root' }),
      formatStatus: 'current',
    })
    await expect(migrateSession(f.ctx, root, { sessionId: 'sub', workspaceId: 'ws-new' })).rejects.toThrow(
      '子会话不提供迁移',
    )
    f.stored.set('root', { header: headerOf('root', oldCwd), formatStatus: 'migration-required' })
    await expect(migrateSession(f.ctx, root, { sessionId: 'root', workspaceId: 'ws-new' })).rejects.toThrow(
      '旧代格式',
    )
  })
})

describe('预设迁移', () => {
  let f: Fixture
  let root: string
  let oldCwd: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-sessions-preset-'))
    oldCwd = join(root, 'old-ws')
    await mkdir(oldCwd)
    f = makeFixture(true)
    ;(f.stored as unknown as { __root?: string }).__root = root
    await writeArtifact(
      root,
      'root',
      oldCwd,
      [eventLine('user/message', {}, 0), eventLine('agent-preset/selected', { agentPreset: 'coder' }, 1)],
      false,
    )
    f.stored.set('root', { header: headerOf('root', oldCwd), formatStatus: 'current' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const artifactPath = (): string =>
    join(root, encodeProjectKey(oldCwd), encodeIdSegment('root'), 'session.v4.jsonl')

  it('改写最后一条选择事件，消息历史不动', async () => {
    const result = await migratePreset(f.ctx, root, { sessionId: 'root', toPreset: 'writer' })
    expect(result).toEqual({ migrated: true, oldPreset: 'coder', newPreset: 'writer' })
    const artifact = await readSessionArtifactFile(artifactPath(), false)
    expect(artifact.header.agentPreset).toBeUndefined()
    const lines = artifact.bodyText.trimEnd().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'user/message', seq: 0 })
    expect(JSON.parse(lines[1]!)).toMatchObject({
      type: 'agent-preset/selected',
      seq: 1,
      data: { agentPreset: 'writer' },
    })
  })

  it('没有选择记录时改写日志头', async () => {
    await rm(artifactPath())
    await writeArtifact(root, 'root', oldCwd, [eventLine('user/message', {}, 0)], false)
    const result = await migratePreset(f.ctx, root, { sessionId: 'root', toPreset: 'writer' })
    expect(result.migrated).toBe(true)
    const artifact = await readSessionArtifactFile(artifactPath(), false)
    expect(artifact.header.agentPreset).toBe('writer')
    expect(artifact.bodyText).toBe(`${eventLine('user/message', {}, 0)}\n`)
  })

  it('同值幂等不改文件', async () => {
    const before = await readFile(artifactPath(), 'utf8')
    const result = await migratePreset(f.ctx, root, { sessionId: 'root', toPreset: 'coder' })
    expect(result.migrated).toBe(false)
    await expect(readFile(artifactPath(), 'utf8')).resolves.toBe(before)
  })

  it('未知预设、宿主无预设服务与已加载会话拒绝', async () => {
    await expect(migratePreset(f.ctx, root, { sessionId: 'root', toPreset: 'nope' })).rejects.toThrow(
      '不存在',
    )
    const bare = { ...f.ctx, get: () => undefined } as unknown as Context
    await expect(migratePreset(bare, root, { sessionId: 'root', toPreset: 'coder' })).rejects.toThrow(
      '未提供 Agent 预设服务',
    )
    f.live.add('root')
    await expect(migratePreset(f.ctx, root, { sessionId: 'root', toPreset: 'coder' })).rejects.toThrow(
      '仍加载在宿主内存中',
    )
  })
})

describe('批量编排', () => {
  let f: Fixture
  let root: string
  let oldCwd: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-sessions-batch-'))
    oldCwd = join(root, 'old-ws')
    await mkdir(oldCwd)
    f = makeFixture(true)
    ;(f.stored as unknown as { __root?: string }).__root = root
    for (const [id, extra] of [
      ['root', {}],
      ['child1', { origin: 'subagent', parentSession: 'root' }],
      ['other', {}],
    ] as const) {
      await writeArtifact(root, id, oldCwd, [eventLine('user/message', {}, 0)], false)
      f.stored.set(id, { header: headerOf(id, oldCwd, extra), formatStatus: 'current' })
    }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('删除级联去重：父子同批时后到者标记 cascaded，只执行一次主删除', async () => {
    const items = await runBatch(f.ctx, root, {
      action: 'delete',
      sessionIds: ['root', 'child1'],
    })
    expect(items).toEqual([
      {
        sessionId: 'root',
        ok: true,
        result: { filesRemoved: true, archiveCleared: true, deletedSubagents: ['child1'] },
      },
      { sessionId: 'child1', ok: true, cascaded: true },
    ])
  })

  it('单项失败不中断后续，失败项携带原始原因', async () => {
    f.live.add('child1')
    const items = await runBatch(f.ctx, root, {
      action: 'delete',
      sessionIds: ['child1', 'other'],
    })
    expect(items[0]!.ok).toBe(false)
    if (!items[0]!.ok) expect(items[0]!.error).toContain('仍加载在宿主内存中')
    expect(items[1]).toMatchObject({ sessionId: 'other', ok: true })
    await expect(exists(join(root, encodeProjectKey(oldCwd), encodeIdSegment('other')))).resolves.toBe(false)
  })

  it('请求去重：重复 id 只执行一次', async () => {
    const items = await runBatch(f.ctx, root, {
      action: 'delete',
      sessionIds: ['other', 'other', 'other'],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ sessionId: 'other', ok: true })
  })

  it('空数组、超上限、未知动作与缺失 payload 显式拒绝', async () => {
    await expect(runBatch(f.ctx, root, { action: 'delete', sessionIds: [] })).rejects.toThrow('非空数组')
    await expect(
      runBatch(f.ctx, root, { action: 'delete', sessionIds: Array.from({ length: 201 }, (_, i) => `s${i}`) }),
    ).rejects.toThrow('200 条')
    await expect(
      runBatch(f.ctx, root, { action: 'explode' as 'delete', sessionIds: ['root'] }),
    ).rejects.toThrow('action 不支持')
    await expect(runBatch(f.ctx, root, { action: 'migrate', sessionIds: ['root'] })).rejects.toThrow(
      'workspaceId',
    )
    await expect(runBatch(f.ctx, root, { action: 'preset', sessionIds: ['root'] })).rejects.toThrow(
      'toPreset',
    )
  })

  it('批量预设逐项执行并逐项返回', async () => {
    const items = await runBatch(f.ctx, root, {
      action: 'preset',
      sessionIds: ['root', 'other'],
      payload: { toPreset: 'writer' },
    })
    expect(items).toEqual([
      { sessionId: 'root', ok: true, result: { migrated: true, oldPreset: undefined, newPreset: 'writer' } },
      { sessionId: 'other', ok: true, result: { migrated: true, oldPreset: undefined, newPreset: 'writer' } },
    ])
  })
})
