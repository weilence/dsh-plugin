import { describe, expect, it, vi } from 'vitest'
import { rowsOf } from '../src/client/SyncDialog'
import type { LocalRowsResponse, RemoteInventoryResponse } from '../src/shared'
import { makeT } from './i18n'

// rowsOf 是纯投影；模块里其余 UI 依赖与取词无关，桩掉以保持 node 环境可导入。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null }))
vi.mock('@dsh-plugins/client-ui', () => ({
  Dialog: () => null,
  IssueList: () => null,
  PickList: () => null,
  SelectField: () => null,
}))

const localRows: LocalRowsResponse = {
  available: true,
  skillRows: [
    { name: 'deploy', root: 'user-dsh', description: '部署技能', digest: 'd1' },
    { name: 'review', root: 'user-agents', description: null, digest: 'd2' },
  ],
  mcpRows: [
    { id: 'mcp-foo', serverName: 'foo', summary: 'npx foo', signature: 's1' },
    { id: 'mcp-bar', serverName: null, summary: 'npx bar', signature: 's2' },
  ],
  pluginRows: [
    {
      id: 'p1',
      name: '@weilence/dsh-skills',
      source: 'profile',
      install: 'local',
      root: '/r',
      version: '1.0.0',
    },
    {
      id: 'p2',
      name: 'lodash',
      source: 'home',
      install: 'registry',
      root: '/r2',
      version: '4.17.21',
    },
  ],
  promptRow: { path: '/home/system-prompt.md', digest: 'p' },
}

const inventory: RemoteInventoryResponse = {
  // user-agents 根的远端管道失败 → 无法比对（保守按不同处理）
  skills: { 'user-dsh': [{ name: 'deploy', digest: 'd0' }], 'user-agents': null },
  mcp: [{ serverName: 'foo', signature: 's0', summary: 'npx foo@remote' }],
  plugins: [
    { name: '@weilence/dsh-skills', version: '0.9.0' },
    { name: 'lodash', version: '4.17.21' },
  ],
  prompts: { exists: true, digest: 'p0' },
}

describe('同步弹窗投影（渲染期取词）', () => {
  it('技能行按根路径 + 判定徽标组装 titleMeta，说明行是事实原样', () => {
    const rows = rowsOf('skills', localRows, inventory)
    expect(rows.map((row) => row.status)).toEqual(['diff', 'unknown'])

    const deploy = rows[0]!.view(makeT())
    expect(deploy.title).toBe('deploy')
    expect(deploy.titleMeta).toBe('~/.dsh/skills · 内容不同')
    expect(deploy.lines).toEqual(['部署技能'])

    const review = rows[1]!.view(makeT())
    expect(review.titleMeta).toBe('~/.agents/skills · 无法比对')
    expect(review.lines).toEqual([])
  })

  it('MCP 行 diff 时附「远端：摘要」对比行，absent 时不附', () => {
    const rows = rowsOf('mcp', localRows, inventory)
    expect(rows.map((row) => row.status)).toEqual(['diff', 'absent'])

    expect(rows[0]!.view(makeT()).lines).toEqual(['npx foo', '远端：npx foo@remote'])
    expect(rows[1]!.view(makeT()).lines).toEqual(['npx bar'])
  })

  it('插件行比版本号并组装层级 / 形态 / 版本元信息', () => {
    const rows = rowsOf('plugins', localRows, inventory)
    expect(rows.map((row) => row.status)).toEqual(['diff', 'same'])

    expect(rows[0]!.view(makeT()).titleMeta).toBe('profile 层 · 本地 · v1.0.0 · 与远端版本不同 · 远端 v0.9.0')
    // same 行：状态走行尾徽标（醒目），titleMeta 留事实（版本相等时远端版本是重复信息）
    const same = rows[1]!.view(makeT())
    expect(same.titleMeta).toBe('home 层 · npm · v4.17.21')
    expect(same.tag).toBe('已一致')
  })

  it('插件远端已激活但版本读不到时给出未知版本措辞', () => {
    const noVersion: RemoteInventoryResponse = {
      ...inventory,
      plugins: [{ name: '@weilence/dsh-skills', version: null }],
    }
    const rows = rowsOf('plugins', localRows, noVersion)
    expect(rows[0]!.status).toBe('unknown')
    expect(rows[0]!.view(makeT()).titleMeta).toBe(
      'profile 层 · 本地 · v1.0.0 · 无法比对 · 远端已激活（版本未知）',
    )
  })

  it('提示词行已一致走徽标、差异走状态文字', () => {
    const rows = rowsOf('prompts', localRows, inventory)
    expect(rows.map((row) => row.status)).toEqual(['diff'])
    const item = rows[0]!.view(makeT())
    expect(item.title).toBe('system-prompt.md')
    expect(item.titleMeta).toBe('内容不同')
    expect(item.lines).toEqual(['/home/system-prompt.md'])

    const sameRows = rowsOf(
      'prompts',
      { ...localRows, promptRow: { path: '/home/system-prompt.md', digest: 'p0' } },
      inventory,
    )
    expect(sameRows[0]!.view(makeT()).tag).toBe('已一致')
    expect(sameRows[0]!.view(makeT()).titleMeta).toBeUndefined()
  })

  it('同一描述子可按语言重取：判定与事实不变，措辞跟随宿主语言', () => {
    const row = rowsOf('skills', localRows, inventory)[0]!
    expect(row.view(makeT('en')).titleMeta).toBe('~/.dsh/skills · content differs')
  })
})
