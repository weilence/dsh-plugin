import { describe, expect, it } from 'vitest'
import { getContextOpen, pushContextOpen, subscribeContextOpen } from '../../src/client/contextOpen'

describe('目录右键菜单的待应用选择 store', () => {
  it('写入递增版本并通知订阅者；消费方按版本判定一次性应用', () => {
    const seen: (string | null)[] = []
    const unsubscribe = subscribeContextOpen(() => seen.push(getContextOpen()?.repoRoot ?? null))
    expect(getContextOpen()).toBeNull()

    pushContextOpen('s1', 'C:/repo-a')
    expect(getContextOpen()).toMatchObject({ version: 1, sessionId: 's1', repoRoot: 'C:/repo-a' })

    pushContextOpen('s1', 'C:/repo-b')
    expect(getContextOpen()).toMatchObject({ version: 2, sessionId: 's1', repoRoot: 'C:/repo-b' })
    expect(seen).toEqual(['C:/repo-a', 'C:/repo-b'])

    unsubscribe()
    pushContextOpen('s2', 'C:/repo-c')
    expect(seen).toEqual(['C:/repo-a', 'C:/repo-b'])
  })
})
