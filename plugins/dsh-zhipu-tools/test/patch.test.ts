import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('安装 patch 只插入插件行，不触碰 web 配置（默认不替换）', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  expect(patch).toContain("name: '@weilence/dsh-zhipu-tools'")
  expect(patch).not.toContain('searchProvider')
  expect(patch).not.toContain('fetchProvider')
  expect(patch).not.toContain('id: web')
})
