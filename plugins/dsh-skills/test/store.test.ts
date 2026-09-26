import { beforeEach, describe, expect, it, vi } from 'vitest'
import { skillsApi } from '../src/client/api'
import { SkillsStore } from '../src/client/store'

describe('SkillsStore 首次加载', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('面板挂载档位为全局时（setScope 与初始作用域同值）也要发起首次加载', async () => {
    const list = vi.fn().mockResolvedValue({ roots: [], skills: [] })
    vi.spyOn(skillsApi, 'list').mockImplementation(list)

    const store = new SkillsStore()
    // SkillsPanel 挂载 effect 的唯一调用：默认全局档 effectiveCwd = ''。
    store.setScope('')

    await vi.waitFor(() => {
      expect(store.getSnapshot().status).toBe('ready')
    })
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(undefined, 'user')
  })
})
