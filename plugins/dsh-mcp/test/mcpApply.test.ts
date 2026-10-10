/** 挂载 diff：期望集 ↔ Loader 实例的增改删与越界保护。 */

import { describe, expect, it } from 'vitest'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { mountedEntries, removeAllEntries, syncEntries, type DesiredEntry } from '../src/mcpApply'
import { ENTRY_PREFIX, MCP_PLUGIN_NAME } from '../src/shared'

interface FakeEntry {
  options: { id: string; name: string; config?: unknown; disabled?: boolean }
  disabled?: boolean
}

interface FakeLoader {
  /** 与真 Loader 的 Dict 形态一致：普通对象，syncEntries 的占用检查走
   *  store[id] 下标访问。 */
  store: Record<string, FakeEntry>
  log: { op: string; id: string }[]
  entries(): Iterator<FakeEntry>
  create(options: { id?: string; name: string; config?: unknown; disabled?: boolean }): Promise<string>
  update(id: string, options: Record<string, unknown>): Promise<string>
  remove(id: string): void
}

function makeLoader(): FakeLoader {
  const store: Record<string, FakeEntry> = Object.create(null)
  const log: { op: string; id: string }[] = []
  return {
    store,
    log,
    entries: () => Object.values(store)[Symbol.iterator](),
    create: async (options) => {
      const id = options.id ?? Math.random().toString(16).slice(2)
      store[id] = { options: { ...options, id } }
      log.push({ op: 'create', id })
      return id
    },
    update: async (id, options) => {
      const entry = store[id]
      if (entry === undefined) throw new Error(`cannot resolve entry ${id}`)
      Object.assign(entry.options, options)
      log.push({ op: 'update', id })
      return id
    },
    remove: (id) => {
      delete store[id]
      log.push({ op: 'remove', id })
    },
  }
}

/** 假 Loader 直接当真 Loader 用：syncEntries 只触上面这五个面。 */
const asLoader = (fake: FakeLoader): Loader => fake as unknown as Loader

const desired = (scope: DesiredEntry['scope'], name: string, command = 'npx'): DesiredEntry => ({
  scope,
  name,
  config: { transport: 'stdio', serverName: name, command },
  disabled: false,
})

describe('syncEntries', () => {
  it('空集 diff 空集不动；新条目 create', async () => {
    const loader = makeLoader()
    await expect(syncEntries(asLoader(loader), [])).resolves.toEqual([])
    expect(loader.log).toEqual([])

    await syncEntries(asLoader(loader), [desired('global', 'demo')])
    expect(loader.log).toEqual([{ op: 'create', id: `${ENTRY_PREFIX}global-demo` }])
    expect(loader.store[`${ENTRY_PREFIX}global-demo`]?.options.config).toMatchObject({ serverName: 'demo' })
  })

  it('配置或停用态变化走 update，无变化跳过', async () => {
    const loader = makeLoader()
    await syncEntries(asLoader(loader), [desired('global', 'demo')])
    loader.log.length = 0

    await syncEntries(asLoader(loader), [desired('global', 'demo')])
    expect(loader.log).toEqual([])

    await syncEntries(asLoader(loader), [{ ...desired('global', 'demo'), disabled: true }])
    expect(loader.log).toEqual([{ op: 'update', id: `${ENTRY_PREFIX}global-demo` }])

    loader.log.length = 0
    await syncEntries(asLoader(loader), [desired('global', 'demo', 'node')])
    expect(loader.log).toEqual([{ op: 'update', id: `${ENTRY_PREFIX}global-demo` }])
    expect(loader.store[`${ENTRY_PREFIX}global-demo`]?.options.config).toMatchObject({ command: 'node' })
  })

  it('期望集消失的条目 remove；只动自己前缀的条目', async () => {
    const loader = makeLoader()
    await syncEntries(asLoader(loader), [desired('global', 'a'), desired('workspace', 'b')])
    loader.log.length = 0

    loader.store['mcp-legacy'] = { options: { id: 'mcp-legacy', name: MCP_PLUGIN_NAME, config: {} } }
    loader.store['other-plugin'] = { options: { id: 'other-plugin', name: 'someone-else' } }

    await syncEntries(asLoader(loader), [desired('global', 'a')])
    expect(loader.log).toEqual([{ op: 'remove', id: `${ENTRY_PREFIX}workspace-b` }])
    expect('mcp-legacy' in loader.store).toBe(true)
    expect('other-plugin' in loader.store).toBe(true)
  })

  it('id 被其他插件占用时跳过并告警，不劫持', async () => {
    const loader = makeLoader()
    loader.store[`${ENTRY_PREFIX}global-demo`] = {
      options: { id: `${ENTRY_PREFIX}global-demo`, name: 'someone-else' },
    }
    const warnings = await syncEntries(asLoader(loader), [desired('global', 'demo')])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('占用')
    expect(loader.store[`${ENTRY_PREFIX}global-demo`]?.options.name).toBe('someone-else')
  })

  it('loader 缺席且期望集非空时告警', async () => {
    const warnings = await syncEntries(undefined, [desired('global', 'demo')])
    expect(warnings).toHaveLength(1)
    expect(await syncEntries(undefined, [])).toEqual([])
  })
})

describe('mountedEntries / removeAllEntries', () => {
  it('只统计本插件带前缀的条目；removeAll 清空它们', async () => {
    const loader = makeLoader()
    await syncEntries(asLoader(loader), [desired('global', 'demo')])
    loader.store['mcp-patch-row'] = { options: { id: 'mcp-patch-row', name: MCP_PLUGIN_NAME, config: {} } }

    expect([...mountedEntries(asLoader(loader)).keys()]).toEqual([`${ENTRY_PREFIX}global-demo`])
    removeAllEntries(asLoader(loader))
    expect(`${ENTRY_PREFIX}global-demo` in loader.store).toBe(false)
    expect('mcp-patch-row' in loader.store).toBe(true)
  })
})
