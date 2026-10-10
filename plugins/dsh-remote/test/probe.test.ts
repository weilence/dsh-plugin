import { describe, expect, it } from 'vitest'
import { parseToolProbe } from '../src/engine'

/** 探查合并命令的输出协议：`__NODE__<值>` 等标记行，值是版本或错误文本。 */
describe('探查合并输出解析', () => {
  it('三个工具齐全时拿到各自版本', () => {
    const probe = parseToolProbe('__NODE__v22.19.0\n__NPM__10.8.2\n__PNPM__10.12.0\n')
    expect(probe).toEqual({ node: 'v22.19.0', npm: '10.8.2', pnpm: '10.12.0' })
  })

  it('工具缺失时对应字段为 null（错误文本不冒充版本）', () => {
    const probe = parseToolProbe(
      '__NODE__bash: node: command not found\n__NPM__10.8.2\n__PNPM__bash: pnpm: command not found\n',
    )
    expect(probe).toEqual({ node: null, npm: '10.8.2', pnpm: null })
  })

  it('输出畸形（无标记行）按整体不可用处理', () => {
    expect(parseToolProbe('garbage output\n')).toEqual({ node: null, npm: null, pnpm: null })
    expect(parseToolProbe('')).toEqual({ node: null, npm: null, pnpm: null })
  })
})
