import { describe, expect, it } from 'vitest'
import {
  saveModelProfile,
  materializeWithNewModel,
  planAddModel,
  removeModelProfile,
} from '../src/pi-ai/profile'

// 写入规划路径：这些函数同时服务「保存」的整值 set providers.<route>，
// 断言直接落在 profile 对象上（用户层落点语义），不经过任何文本渲染。

describe('写入规划路径', () => {
  const catalog = new Map([
    ['alpha', { name: 'Alpha', contextWindow: 1000, maxTokens: 100 }],
    ['beta', { name: 'Beta' }],
  ])
  const row = {
    id: 'alpha',
    name: 'Alpha',
    userEntry: undefined,
    catalogEntry: { id: 'alpha', contextWindow: 1000 },

    writeSite: 'catalog' as const,
  }

  it('目录 route 编辑既有模型 → 写 modelOverrides 而非 models', () => {
    const profile = saveModelProfile('inherited', undefined, row, { id: 'alpha', maxTokens: 7 })
    expect(profile.modelOverrides).toBeDefined()
    expect(profile.models).toBeUndefined()
  })

  it('新增目录未描述模型 → 展开完整 models 清单', () => {
    const plan = planAddModel({
      source: 'inherited',
      userProfile: undefined,
      catalog,
      entry: { id: 'gamma' },
    })
    expect(plan.kind).toBe('materialize')
    if (plan.kind !== 'materialize') return
    const ids = (plan.profile.models ?? []).map((entry) => entry.id)
    expect(ids).toContain('alpha')
    expect(ids).toContain('beta')
    expect(ids).toContain('gamma')
  })

  it('展开时 modelOverrides 必须已清掉（官方 models / modelOverrides 互斥）', () => {
    const plan = planAddModel({
      source: 'inherited',
      userProfile: undefined,
      catalog,
      entry: { id: 'gamma' },
    })
    expect(plan.kind).toBe('materialize')
    if (plan.kind !== 'materialize') return
    expect(plan.profile.modelOverrides).toBeUndefined()
  })

  it('目录读不到时 blocked，与写入路径一致（原因为词典描述子）', () => {
    const plan = planAddModel({
      source: 'inherited',
      userProfile: undefined,
      catalog: new Map(),
      entry: { id: 'x' },
    })
    expect(plan).toEqual({ kind: 'blocked', reason: { key: 'plan.catalogUnreadable' } })
  })

  it('materializeWithNewModel 与 planAddModel 输出一致', () => {
    const direct = materializeWithNewModel(undefined, catalog, { id: 'gamma' })
    const planned = planAddModel({
      source: 'inherited',
      userProfile: undefined,
      catalog,
      entry: { id: 'gamma' },
    })
    expect(planned.kind === 'materialize' ? planned.profile : null).toEqual(direct)
  })

  it('删除目录内模型 → 展开完整 models 清单并移出该模型', () => {
    const profile = removeModelProfile('inherited', undefined, row, catalog)
    expect((profile.models ?? []).map((entry) => entry.id)).toEqual(['beta'])
    expect(profile.modelOverrides).toBeUndefined()
  })
})
