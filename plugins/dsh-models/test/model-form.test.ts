import { describe, expect, it, vi } from 'vitest'
import { mergedAutofillDraft, type Draft } from '../src/client/ModelForm'
import type { PiAiModelEntry } from '../src/pi-ai/types'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DisclosureRow: () => null,
  Switch: () => null,
  IconSettingsOutlineRegular: () => null,
}))

vi.mock('@dsh-plugins/client-ui', () => ({
  IssueList: () => null,
  TextAreaField: () => null,
  TextField: () => null,
}))

// 合并语义单测（组件里的防抖接线靠纯函数锁行为）：字段为空白或仍等于上次
// 填充值时采纳新值，用户手动改过的字段永不覆盖。
function blankDraft(): Draft {
  return {
    name: '',
    contextWindow: '',
    maxTokens: '',
    input: { image: false },
    disableEfforts: false,
    efforts: {},
    compatText: '',
  }
}

const gpt4: PiAiModelEntry = {
  id: 'gpt-4',
  name: 'GPT 4',
  contextWindow: 128000,
  maxTokens: 4096,
  input: ['text'],
  reasoningEfforts: { low: 'low' },
}

const gpt4o: PiAiModelEntry = {
  id: 'gpt-4o',
  name: 'GPT 4o',
  contextWindow: 256000,
  maxTokens: 16384,
  input: ['text', 'image'],
}

describe('新增模型自动填充合并', () => {
  it('空白表单全字段采纳', () => {
    const next = mergedAutofillDraft(blankDraft(), gpt4, undefined)
    expect(next).toMatchObject({
      name: 'GPT 4',
      contextWindow: '128000',
      maxTokens: '4096',
      input: { image: false },
      disableEfforts: false,
      efforts: { low: 'low' },
    })
    expect(next.compatText).toBe('')
  })

  it('重查替换仍等于上次填充的字段（半截 id 自愈）', () => {
    const filled = mergedAutofillDraft(blankDraft(), gpt4, undefined)
    const healed = mergedAutofillDraft(filled, gpt4o, gpt4)
    expect(healed).toMatchObject({
      name: 'GPT 4o',
      contextWindow: '256000',
      maxTokens: '16384',
      input: { image: true },
      // 上次填充的推理档位被新条目（未提供）清回空白。
      efforts: {},
    })
  })

  it('用户手改过的字段永不覆盖，其余字段照常更新', () => {
    let draft = mergedAutofillDraft(blankDraft(), gpt4, undefined)
    draft = { ...draft, name: '我的名字', maxTokens: '777' }
    draft = mergedAutofillDraft(draft, gpt4o, gpt4)
    expect(draft.name).toBe('我的名字')
    expect(draft.maxTokens).toBe('777')
    expect(draft.contextWindow).toBe('256000')
    expect(draft.input.image).toBe(true)
  })

  it('用户清空字段后下次填充重新采纳', () => {
    let draft = mergedAutofillDraft(blankDraft(), gpt4, undefined)
    draft = { ...draft, contextWindow: '' }
    expect(mergedAutofillDraft(draft, gpt4o, gpt4).contextWindow).toBe('256000')
  })

  it('reasoningEfforts: false 填充为「不支持推理」', () => {
    const next = mergedAutofillDraft(blankDraft(), { id: 'm', reasoningEfforts: false }, undefined)
    expect(next.disableEfforts).toBe(true)
    expect(next.efforts).toEqual({})
  })
})
