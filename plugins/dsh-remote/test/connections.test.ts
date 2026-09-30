/** 连接库：校验归一 + 持久化往返 + 损坏文件回空库。 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ValidationError, normalizeConnection, readStore, writeStore } from '../src/connections'
import type { RemoteConnection, SaveRequest } from '../src/shared'

const NOW = '2027-01-01T00:00:00.000Z'

function request(overrides: Partial<SaveRequest> = {}): SaveRequest {
  return {
    label: '开发机',
    sshAlias: 'dev-box',
    ...overrides,
  }
}

describe('normalizeConnection', () => {
  it('最小请求归一（id 从别名派生）', () => {
    const connection = normalizeConnection(request(), new Set(), NOW)
    expect(connection.id).toBe('dev-box')
    expect(connection.label).toBe('开发机')
    expect(connection.sshAlias).toBe('dev-box')
    expect(connection.createdAt).toBe(NOW)
  })

  it('id 冲突时加随机后缀；大写与特殊字符被压成 kebab', () => {
    const connection = normalizeConnection(request({ sshAlias: 'My.Box_01' }), new Set(['my-box-01']), NOW)
    expect(connection.id).toMatch(/^my-box-01-[0-9a-f]{4}$/)
  })

  it('编辑沿用原 id 与 createdAt', () => {
    const previous: RemoteConnection = {
      id: 'fixed-id',
      label: '旧名',
      sshAlias: 'dev-box',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const connection = normalizeConnection(request({ label: '新名' }), new Set(), NOW, previous)
    expect(connection.id).toBe('fixed-id')
    expect(connection.label).toBe('新名')
    expect(connection.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('非法输入：空 label / 坏别名', () => {
    expect(() => normalizeConnection(request({ label: '  ' }), new Set(), NOW)).toThrow(ValidationError)
    expect(() => normalizeConnection(request({ sshAlias: 'a b' }), new Set(), NOW)).toThrow(ValidationError)
    expect(() => normalizeConnection(request({ sshAlias: '-lead' }), new Set(), NOW)).toThrow(ValidationError)
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
    const connection = normalizeConnection(request(), new Set(), NOW)
    await writeStore(home, {
      version: 1,
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
  })

  it('缺失 / 损坏 / 形状不对回空库', async () => {
    expect((await readStore(home)).connections).toEqual([])
    await writeFile(join(home, 'dsh-remote.json'), '{broken', 'utf8')
    expect((await readStore(home)).connections).toEqual([])
    await writeFile(join(home, 'dsh-remote.json'), JSON.stringify({ connections: 'nope' }), 'utf8')
    expect((await readStore(home)).connections).toEqual([])
  })

  it('旧库带 sync 字段：读入容忍（额外字段忽略，不再是连接的一部分）', async () => {
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
      sshAlias: 'dev-box',
      createdAt: NOW,
      updatedAt: NOW,
      // 旧 sync 字段被剥离：勾选已随 POST /sync 直传，不在连接上持久化
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
    await writeStore(home, { version: 1, connections: [], manifest: {} })
    const text = await readFile(join(home, 'dsh-remote.json'), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toMatchObject({ version: 1 })
  })
})
