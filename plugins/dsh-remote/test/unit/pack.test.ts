import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packPackage } from '../../src/index'

// packPackage 的端到端打包语义由 test/integration/pack.test.ts 真跑 pnpm 覆盖
// （Windows 按约定跳过）；这里只锁定解析不到 pnpm 时的显式报错分支——集成
// 测不了（Windows 跳过），环境修好后再也遇不到，注入是最可靠的事实源。
describe('packPackage 的 pnpm 解析口径', () => {
  it('win32 解析不到 pnpm → 抛可读的显式错误，不经 shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-packunit-'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@x/y', version: '0.0.0' }), 'utf8')
    await expect(packPackage(dir, { win32: true, resolvePnpm: () => null })).rejects.toThrow(
      '本机未找到 pnpm',
    )
  })
})
