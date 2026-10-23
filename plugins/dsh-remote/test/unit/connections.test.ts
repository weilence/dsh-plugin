/** 连接库：目标校验 + 口令持久化规则 + v1 迁移 + 持久化往返 + 脱敏投影。 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ValidationError,
  normalizeConnection,
  readStore,
  toRemoteConnection,
  writeStore,
  type StoredConnection,
} from '../../src/connections'
import type { SaveRequest } from '../../src/shared'

const NOW = '2027-01-01T00:00:00.000Z'

function request(overrides: Partial<SaveRequest> = {}): SaveRequest {
  return {
    label: '开发机',
    target: { kind: 'alias', alias: 'dev-box' },
    rememberSecret: false,
    ...overrides,
  }
}

function directRequest(overrides: Partial<SaveRequest> = {}): SaveRequest {
  return request({
    target: {
      kind: 'direct',
      host: '10.0.0.5',
      port: 2222,
      user: 'root',
      auth: 'password',
      identityFile: null,
    },
    secret: 's3cret',
    ...overrides,
  })
}

describe('normalizeConnection', () => {
  it('别名连接：id 从别名派生、口令恒为空', async () => {
    const normalized = await normalizeConnection(request(), new Set(), NOW)
    const connection = normalized.connection
    expect(connection.id).toBe('dev-box')
    expect(connection.label).toBe('开发机')
    expect(connection.target).toEqual({ kind: 'alias', alias: 'dev-box' })
    expect(connection.secret).toBeNull()
    expect(normalized.secret).toBeNull()
    expect(connection.createdAt).toBe(NOW)
  })

  it('id 冲突时加随机后缀；大写与特殊字符被压成 kebab', async () => {
    const normalized = await normalizeConnection(
      request({ target: { kind: 'alias', alias: 'My.Box_01' } }),
      new Set(['my-box-01']),
      NOW,
    )
    expect(normalized.connection.id).toMatch(/^my-box-01-[0-9a-f]{4}$/)
  })

  it('编辑沿用原 id 与 createdAt', async () => {
    const previous: StoredConnection = {
      id: 'fixed-id',
      label: '旧名',
      target: { kind: 'alias', alias: 'dev-box' },
      secret: null,
      rememberSecret: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const normalized = await normalizeConnection(request({ label: '新名' }), new Set(), NOW, previous)
    expect(normalized.connection.id).toBe('fixed-id')
    expect(normalized.connection.label).toBe('新名')
    expect(normalized.connection.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('非法输入：空 label / 坏别名 / 坏地址 / 坏端口 / 坏用户', async () => {
    await expect(normalizeConnection(request({ label: '  ' }), new Set(), NOW)).rejects.toThrow(
      ValidationError,
    )
    await expect(
      normalizeConnection(request({ target: { kind: 'alias', alias: 'a b' } }), new Set(), NOW),
    ).rejects.toThrow(ValidationError)
    for (const host of ['a b', '-lead', 'example.com:2222', 'user@host']) {
      await expect(
        normalizeConnection(
          directRequest({
            target: {
              kind: 'direct',
              host,
              port: null,
              user: null,
              auth: 'password',
              identityFile: null,
            },
          }),
          new Set(),
          NOW,
        ),
      ).rejects.toThrow(ValidationError)
    }
    await expect(
      normalizeConnection(
        directRequest({
          target: { kind: 'direct', host: 'a', port: 0, user: null, auth: 'password', identityFile: null },
        }),
        new Set(),
        NOW,
      ),
    ).rejects.toThrow(ValidationError)
    await expect(
      normalizeConnection(
        directRequest({
          target: {
            kind: 'direct',
            host: 'a',
            port: null,
            user: 'a@b',
            auth: 'password',
            identityFile: null,
          },
        }),
        new Set(),
        NOW,
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('密码登录不强制落盘口令：清除后由面板现场补录', async () => {
    const normalized = await normalizeConnection(directRequest({ secret: undefined }), new Set(), NOW)
    expect(normalized.connection.secret).toBeNull()
    expect(normalized.secret).toBeNull()
    expect(normalized.connection.rememberSecret).toBe(false)

    const remembered = await normalizeConnection(directRequest({ rememberSecret: true }), new Set(), NOW)
    expect(remembered.connection.secret).toBe('s3cret')
    expect(remembered.secret).toBe('s3cret')

    const session = await normalizeConnection(directRequest(), new Set(), NOW)
    expect(session.connection.secret).toBeNull()
    expect(session.secret).toBe('s3cret')
  })

  it('编辑留空沿用旧口令（含只在内存里的），显式空串清除', async () => {
    const previous = (await normalizeConnection(directRequest({ rememberSecret: true }), new Set(), NOW))
      .connection
    const kept = await normalizeConnection(
      directRequest({ id: previous.id, secret: undefined, rememberSecret: true }),
      new Set(),
      NOW,
      previous,
      's3cret',
    )
    expect(kept.connection.secret).toBe('s3cret')

    const cleared = await normalizeConnection(
      directRequest({ id: previous.id, secret: '' }),
      new Set(),
      NOW,
      previous,
    )
    expect(cleared.connection.secret).toBeNull()
    expect(cleared.secret).toBeNull()
  })

  it('切认证方式且没重填口令时不沿用旧口令', async () => {
    const previous = (await normalizeConnection(directRequest({ rememberSecret: true }), new Set(), NOW))
      .connection
    const keyHome = await mkdtemp(join(tmpdir(), 'dsh-remote-switch-'))
    const keyFile = join(keyHome, 'id_ed25519')
    await writeFile(keyFile, 'PRIVATE', 'utf8')
    try {
      const switched = await normalizeConnection(
        request({
          id: previous.id,
          target: {
            kind: 'direct',
            host: '10.0.0.5',
            port: 2222,
            user: 'root',
            auth: 'key',
            identityFile: keyFile,
          },
          secret: undefined,
        }),
        new Set(),
        NOW,
        previous,
      )
      // 密钥口令是可选的：旧密码不会被当成口令带过去
      expect(switched.connection.secret).toBeNull()
      expect(switched.secret).toBeNull()
    } finally {
      await rm(keyHome, { recursive: true, force: true })
    }
  })

  it('密钥认证：路径必须存在且为绝对路径', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-remote-key-'))
    const keyFile = join(home, 'id_ed25519')
    await writeFile(keyFile, 'PRIVATE', 'utf8')
    try {
      const normalized = await normalizeConnection(
        request({
          target: {
            kind: 'direct',
            host: 'box',
            port: null,
            user: null,
            auth: 'key',
            identityFile: keyFile,
          },
        }),
        new Set(),
        NOW,
      )
      expect(normalized.connection.target).toEqual({
        kind: 'direct',
        host: 'box',
        port: null,
        user: null,
        auth: 'key',
        identityFile: keyFile,
      })
      await expect(
        normalizeConnection(
          request({
            target: {
              kind: 'direct',
              host: 'box',
              port: null,
              user: null,
              auth: 'key',
              identityFile: join(home, 'missing'),
            },
          }),
          new Set(),
          NOW,
        ),
      ).rejects.toThrow(ValidationError)
      await expect(
        normalizeConnection(
          request({
            target: {
              kind: 'direct',
              host: 'box',
              port: null,
              user: null,
              auth: 'key',
              identityFile: 'relative/key',
            },
          }),
          new Set(),
          NOW,
        ),
      ).rejects.toThrow(ValidationError)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('store 持久化', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-remote-store-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('写入后读回一致（manifest 只是记录）', async () => {
    const connection = (await normalizeConnection(directRequest({ rememberSecret: true }), new Set(), NOW))
      .connection
    await writeStore(home, {
      version: 2,
      connections: [connection],
      manifest: {
        'dev-box': {
          skills: { 'user-dsh': ['a'] },
          mcp: ['mcp-a'],
          plugins: ['@weilence/dsh-mcp'],
          prompts: false,
        },
      },
    })
    const store = await readStore(home)
    expect(store.connections).toEqual([connection])
    expect(store.manifest['dev-box']).toEqual({
      skills: { 'user-dsh': ['a'] },
      mcp: ['mcp-a'],
      plugins: ['@weilence/dsh-mcp'],
      prompts: false,
    })
    const mode = (await stat(join(home, 'dsh-remote.json'))).mode & 0o777
    // Windows 上 mode 不受支持，posix 上必须是 0600（口令可能落在文件里）
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
  })

  it('缺失 / 损坏 / 形状不对回空库', async () => {
    expect((await readStore(home)).connections).toEqual([])
    await writeFile(join(home, 'dsh-remote.json'), '{broken', 'utf8')
    expect((await readStore(home)).connections).toEqual([])
    await writeFile(join(home, 'dsh-remote.json'), JSON.stringify({ connections: 'nope' }), 'utf8')
    expect((await readStore(home)).connections).toEqual([])
  })

  it('v1 的 sshAlias 记录迁移为别名目标，旧字段剥离', async () => {
    await writeFile(
      join(home, 'dsh-remote.json'),
      JSON.stringify({
        connections: [
          {
            id: 'dev-box',
            label: '开发机',
            sshAlias: 'dev-box',
            sync: { mcpServerNames: [], pluginNames: [] },
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        manifest: {},
      }),
      'utf8',
    )
    const store = await readStore(home)
    expect(store.connections[0]).toEqual({
      id: 'dev-box',
      label: '开发机',
      target: { kind: 'alias', alias: 'dev-box' },
      secret: null,
      rememberSecret: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  })

  it('manifest 的 prompts 字段：旧库缺省读入归一 false，形状不对整条丢弃', async () => {
    await writeFile(
      join(home, 'dsh-remote.json'),
      JSON.stringify({
        connections: [],
        manifest: {
          good: { skills: {}, mcp: [], plugins: [], prompts: true },
          legacy: { skills: { 'user-dsh': ['a'] }, mcp: [], plugins: [] },
          broken: { skills: {}, mcp: [], plugins: [], prompts: 'yes' },
        },
      }),
      'utf8',
    )
    const store = await readStore(home)
    expect(store.manifest.good?.prompts).toBe(true)
    // 提示词同步加入前的旧库：读入补默认（manifest 只是记录，不驱动判定）
    expect(store.manifest.legacy).toEqual({
      skills: { 'user-dsh': ['a'] },
      mcp: [],
      plugins: [],
      prompts: false,
    })
    expect(store.manifest.broken).toBeUndefined()
  })

  it('落盘是 JSON + 结尾换行', async () => {
    await writeStore(home, { version: 2, connections: [], manifest: {} })
    const text = await readFile(join(home, 'dsh-remote.json'), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toMatchObject({ version: 2 })
  })
})

describe('toRemoteConnection', () => {
  const base: StoredConnection = {
    id: 'box',
    label: '开发机',
    target: { kind: 'alias', alias: 'dev-box' },
    secret: null,
    rememberSecret: false,
    createdAt: NOW,
    updatedAt: NOW,
  }

  it('口令值永不出现在投影里，只留三态', () => {
    expect(toRemoteConnection({ ...base, secret: 'pw' }, false).secretState).toBe('saved')
    expect(toRemoteConnection({ ...base, secret: null }, true).secretState).toBe('session')
    expect(toRemoteConnection({ ...base, secret: null }, false).secretState).toBe('none')
    expect(JSON.stringify(toRemoteConnection({ ...base, secret: 'pw' }, false))).not.toContain('pw')
  })
})
