import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packPackage } from '../src/index'

// packPackage 走真实 pnpm pack——fake 依赖测不出产物语义（发布语义打包、
// 产物命名），真跑子进程才算数（与 forwards.test 的真子进程用例同口径）。
// Windows 的 pnpm 是 .cmd（node 直接 spawn 被拒）与 pnpm 缺席的环境都跳过。
const hasPnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).status === 0
const suite = process.platform === 'win32' || !hasPnpm ? describe.skip : describe

suite('packPackage（pnpm pack）', () => {
  it('产物名 <扁平化包名>-<version>-<内容盐8>.tgz 且落盘可读', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-packfixture-'))
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: '@x/y-pkg', version: '1.2.3' }),
        'utf8',
      )
      await writeFile(join(dir, 'extra.txt'), 'content', 'utf8')
      const packed = await packPackage(dir)
      // 内容盐 = tgz 字节 sha256 前 8 位：同版本换内容（强制重推）时 specifier
      // 变化，hoisted linker 才会真正重新解包
      expect(packed.fileName).toMatch(/^x-y-pkg-1\.2\.3-[0-9a-f]{8}\.tgz$/)
      await readFile(packed.path)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('包根缺 package.json → pnpm 报错原样上抛', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-packempty-'))
    try {
      await expect(packPackage(dir)).rejects.toThrow('pnpm pack 失败')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
