import { beforeEach, describe, expect, it, vi } from 'vitest'
import { skillsApi } from '../src/client/api'
import { SkillsStore } from '../src/client/store'
import { makeT } from './i18n'

describe('SkillsStore 首次加载', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('面板挂载档位为全局时（setScope 与初始作用域同值）也要发起首次加载', async () => {
    const list = vi.fn().mockResolvedValue({ roots: [], skills: [] })
    vi.spyOn(skillsApi, 'list').mockImplementation(list)

    const store = new SkillsStore(makeT())
    // SkillsPanel 挂载 effect 的唯一调用：默认全局档 effectiveCwd = ''。
    store.setScope('')

    await vi.waitFor(() => {
      expect(store.getSnapshot().status).toBe('ready')
    })
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(undefined, 'user')
  })

  it('保存成功后 notice 在事件时间取词（zh 下与原中文一致）', async () => {
    const save = vi.fn().mockResolvedValue({ path: 'C:/root/my-skill.md' })
    vi.spyOn(skillsApi, 'save').mockImplementation(save)
    vi.spyOn(skillsApi, 'list').mockResolvedValue({ roots: [], skills: [] })

    const store = new SkillsStore(makeT())
    store.setScope('')
    await expect(
      store.save({
        cwd: undefined,
        rootId: 'user-dsh',
        name: 'my-skill',
        description: '做某事',
        modelInvocable: true,
        userInvocable: true,
        body: '',
      }),
    ).resolves.toBe(true)

    expect(store.getSnapshot().notice).toBe('已创建技能 my-skill（C:/root/my-skill.md）')
  })
})
