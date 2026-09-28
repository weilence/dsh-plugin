import { describe, expect, it } from 'vitest'
import {
  materializeWithNewModel,
  patchUserProfile,
  removeModelProfile,
  routeModelRows,
  routeSource,
  saveModelProfile,
  entryMatchesCatalog,
} from '../src/pi-ai/profile'
import { normalizeModelEntry } from '../src/pi-ai/normalize'
import {
  validateReasoningEfforts,
  validateModelEntry,
  validateProviderReasoning,
} from '../src/pi-ai/validate'
import { jsonEqual, classifyWrite } from '../src/pi-ai/ops'

const catalog = new Map([
  ['alpha', { name: 'Alpha', contextWindow: 1000, maxTokens: 100 }],
  ['beta', { name: 'Beta', contextWindow: 2000, maxTokens: 200 }],
])

describe('route 来源状态', () => {
  it('区分手写 / 显式清单 / 目录覆盖 / 目录继承', () => {
    expect(routeSource(true, undefined)).toBe('declared')
    expect(routeSource(false, undefined)).toBe('inherited')
    expect(routeSource(false, { models: [{ id: 'a' }] })).toBe('explicit')
    expect(routeSource(false, { modelOverrides: { a: { id: 'a' } } })).toBe('overridden')
  })

  it('显式清单与目录 route 的模型行来源不同', () => {
    const explicit = routeModelRows('explicit', { models: [{ id: 'x' }] }, catalog)
    expect(explicit.map((row) => row.writeSite)).toEqual(['models'])
    const inherited = routeModelRows('inherited', undefined, catalog)
    expect(inherited.map((row) => row.writeSite)).toEqual(['catalog', 'catalog'])
    const overridden = routeModelRows(
      'overridden',
      { modelOverrides: { alpha: { id: 'alpha', maxTokens: 9 } } },
      catalog,
    )
    expect(overridden.find((row) => row.id === 'alpha')?.writeSite).toBe('modelOverrides')
    expect(overridden.find((row) => row.id === 'beta')?.writeSite).toBe('catalog')
  })

  it('modelOverrides 点名目录未描述的模型仍然展示（供修复/删除）', () => {
    const rows = routeModelRows('overridden', { modelOverrides: { ghost: { id: 'ghost' } } }, catalog)
    expect(rows.map((row) => row.id)).toContain('ghost')
  })
})

describe('保存单个模型能力', () => {
  it('目录 route 写 modelOverrides，不物化目录', () => {
    const row = {
      id: 'alpha',
      name: 'Alpha',
      userEntry: undefined,
      catalogEntry: { id: 'alpha', contextWindow: 1000 },
      writeSite: 'catalog' as const,
    }
    const next = saveModelProfile('inherited', undefined, row, {
      id: 'alpha',
      reasoningEfforts: { low: 'low', high: 'high' },
    })
    expect(next).toEqual({
      modelOverrides: { alpha: { id: 'alpha', reasoningEfforts: { low: 'low', high: 'high' } } },
    })
    expect(next).not.toHaveProperty('models')
  })

  it('保存后与目录默认完全等价时删除 override（恢复继承）', () => {
    const row = {
      id: 'alpha',
      name: 'Alpha',
      userEntry: { id: 'alpha', maxTokens: 50 },
      catalogEntry: { id: 'alpha', contextWindow: 1000, maxTokens: 100 },
      writeSite: 'modelOverrides' as const,
    }
    const next = saveModelProfile(
      'overridden',
      { modelOverrides: { alpha: { id: 'alpha', maxTokens: 50 } } },
      row,
      { id: 'alpha' },
    )
    expect(next).toEqual({})
  })

  it('显式清单重写 models 数组里对应条目，保留其它条目', () => {
    const row = {
      id: 'a',
      name: 'A',
      userEntry: { id: 'a' },
      catalogEntry: undefined,
      writeSite: 'models' as const,
    }
    const next = saveModelProfile('explicit', { models: [{ id: 'a' }, { id: 'b' }] }, row, {
      id: 'a',
      maxTokens: 42,
    })
    expect(next).toEqual({ models: [{ id: 'a', maxTokens: 42 }, { id: 'b' }] })
  })

  it('保留面板不编辑的既有模型字段', () => {
    const normalized = normalizeModelEntry({ id: 'a', samplingParams: { temperature: 0.2 }, name: 'A' })
    expect(normalized).toEqual({ id: 'a', name: 'A', samplingParams: { temperature: 0.2 } })
  })

  it('reasoningEfforts 输出按官方等级顺序', () => {
    const row = {
      id: 'a',
      name: 'A',
      userEntry: undefined,
      catalogEntry: undefined,
      writeSite: 'models' as const,
    }
    const next = saveModelProfile('explicit', { models: [{ id: 'a' }] }, row, {
      id: 'a',
      reasoningEfforts: { high: 'high', low: 'low', off: null },
    })
    expect(Object.keys((next.models?.[0]?.reasoningEfforts as object) ?? {})).toEqual(['off', 'low', 'high'])
  })
})

describe('删除与重置', () => {
  it('目录 route 删除模型只删 override', () => {
    const row = {
      id: 'alpha',
      name: 'Alpha',
      userEntry: { id: 'alpha' },
      catalogEntry: undefined,
      writeSite: 'modelOverrides' as const,
    }
    expect(removeModelProfile('overridden', { modelOverrides: { alpha: { id: 'alpha' } } }, row)).toEqual({})
  })

  it('显式清单删除模型从数组移除', () => {
    const row = {
      id: 'a',
      name: 'A',
      userEntry: { id: 'a' },
      catalogEntry: undefined,
      writeSite: 'models' as const,
    }
    expect(removeModelProfile('explicit', { models: [{ id: 'a' }, { id: 'b' }] }, row)).toEqual({
      models: [{ id: 'b' }],
    })
  })
})

describe('目录未描述模型触发物化', () => {
  it('把目录折叠成显式清单，再追加新模型', () => {
    const next = materializeWithNewModel(
      { modelOverrides: { alpha: { id: 'alpha', reasoningEfforts: { low: 'low' } } } },
      catalog,
      { id: 'gamma', name: 'Gamma' },
    )
    expect(next.modelOverrides).toBeUndefined()
    expect(next.models).toHaveLength(3)
    expect(next.models?.find((model) => model.id === 'alpha')?.reasoningEfforts).toEqual({ low: 'low' })
    expect(next.models?.find((model) => model.id === 'beta')).toEqual({
      id: 'beta',
      name: 'Beta',
      contextWindow: 2000,
      maxTokens: 200,
    })
    expect(next.models?.at(-1)?.id).toBe('gamma')
  })
})

describe('写入候选构造', () => {
  it('patch 中 undefined 表示删除用户层字段', () => {
    expect(
      patchUserProfile({ apiKeyEnv: 'K', models: [{ id: 'a' }] }, { models: undefined, displayName: 'X' }),
    ).toEqual({
      apiKeyEnv: 'K',
      displayName: 'X',
    })
  })

  it('写入结果分类到 UI 语义', () => {
    expect(classifyWrite({ ok: true })).toEqual({ kind: 'written' })
    expect(classifyWrite({ ok: false, error: { code: 'settings/conflict', message: 'stale' } })).toEqual({
      kind: 'conflict',
      message: 'stale',
    })
    expect(classifyWrite({ ok: false, error: { message: 'no' } })).toEqual({ kind: 'refused', message: 'no' })
  })

  it('jsonEqual 用于避免同值写', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  it('entryMatchesCatalog 忽略 id 比较其余字段', () => {
    expect(entryMatchesCatalog({ id: 'a', maxTokens: 5 }, { id: 'a', maxTokens: 5 })).toBe(true)
    expect(entryMatchesCatalog({ id: 'a', maxTokens: 6 }, { id: 'a', maxTokens: 5 })).toBe(false)
    expect(entryMatchesCatalog({ id: 'a' }, undefined)).toBe(false)
  })
})

describe('Provider 默认推理等级', () => {
  it('空值继承、合法等级写入、清空时删除用户层覆盖', () => {
    const levels = ['off', 'low', 'high'] as const
    expect(validateProviderReasoning('  ', levels)).toBeUndefined()
    expect(validateProviderReasoning(' high ', levels)).toBeUndefined()
    expect(patchUserProfile({ apiKeyEnv: 'KEY' }, { reasoning: 'high' })).toEqual({
      apiKeyEnv: 'KEY',
      reasoning: 'high',
    })
    expect(patchUserProfile({ reasoning: 'high' }, { reasoning: undefined })).toEqual({})
  })

  it('拒绝不在官方 schema 内的等级', () => {
    expect(validateProviderReasoning('extreme', ['off', 'low', 'high'])).toEqual({
      path: 'reasoning',
      message: '未知默认推理等级「extreme」；可用等级为 off, low, high',
    })
  })
})

describe('官方 reasoningEfforts 校验规则', () => {
  it('继承与 false 合法', () => {
    expect(validateReasoningEfforts(undefined)).toEqual([])
    expect(validateReasoningEfforts(false)).toEqual([])
  })

  it('空字典与只有 off 都非法', () => {
    expect(validateReasoningEfforts({})).toHaveLength(1)
    expect(validateReasoningEfforts({ off: null }).some((issue) => issue.path === 'reasoningEfforts')).toBe(
      true,
    )
  })

  it('未知等级非法', () => {
    expect(
      validateReasoningEfforts({ extreme: 'x' }).some((issue) => issue.path === 'reasoningEfforts.extreme'),
    ).toBe(true)
  })

  it('非 off 等级必须给出非空 wire 值', () => {
    expect(
      validateReasoningEfforts({ high: null }).some((issue) => issue.path === 'reasoningEfforts.high'),
    ).toBe(true)
    expect(
      validateReasoningEfforts({ high: '' }).some((issue) => issue.path === 'reasoningEfforts.high'),
    ).toBe(true)
    expect(validateReasoningEfforts({ off: null, high: 'ultra' })).toEqual([])
  })

  it('模型校验覆盖容量、模态与 id', () => {
    expect(validateModelEntry({ id: '' }).some((issue) => issue.path === 'id')).toBe(true)
    expect(
      validateModelEntry({ id: 'a', contextWindow: 0 }).some((issue) => issue.path === 'contextWindow'),
    ).toBe(true)
    expect(validateModelEntry({ id: 'a', maxTokens: 1.5 }).some((issue) => issue.path === 'maxTokens')).toBe(
      true,
    )
    expect(
      validateModelEntry({ id: 'a', input: ['text', 'audio'] }).some((issue) => issue.path === 'input'),
    ).toBe(true)
    expect(
      validateModelEntry({ id: 'a', input: ['text', 'text'] }).some((issue) => issue.path === 'input'),
    ).toBe(true)
    expect(validateModelEntry({ id: 'a', input: [], reasoningEfforts: false })).toEqual([])
  })
})
