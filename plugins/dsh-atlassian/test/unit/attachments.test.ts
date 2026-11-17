import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachmentPath,
  defaultAttachmentsRoot,
  sanitizeFilename,
  saveAttachment,
} from '../../src/attachments'

let roots: string[] = []
async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-atlassian-attachments-'))
  roots.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('sanitizeFilename', () => {
  it('路径分隔符与控制字符替换、空名与点点回落、超长截断', () => {
    expect(sanitizeFilename('a/b\\c.png')).toBe('a_b_c.png')
    expect(sanitizeFilename('x:y*z.png')).toBe('x_y_z.png')
    expect(sanitizeFilename('x\u0000y.png')).toBe('x_y.png')
    expect(sanitizeFilename('..')).toBe('attachment')
    expect(sanitizeFilename('  ')).toBe('attachment')
    expect(sanitizeFilename('n'.repeat(200))).toHaveLength(120)
    expect(sanitizeFilename('正常-截图.png')).toBe('正常-截图.png')
  })
})

describe('attachmentPath / saveAttachment', () => {
  it('路径带 id 前缀且穿越被消毒，保存内容完整、同名覆盖即缓存刷新', async () => {
    const root = await tmpRoot()
    expect(attachmentPath(root, '100', 'a/b.png')).toBe(join(root, '100-a_b.png'))
    expect(attachmentPath(root, '100', '../evil.png')).toBe(join(root, '100-.._evil.png'))

    const saved = await saveAttachment(root, '100', 'a b.png', Buffer.from('内容'))
    expect(saved).toBe(attachmentPath(root, '100', 'a b.png'))
    await expect(readFile(saved, 'utf8')).resolves.toBe('内容')

    await saveAttachment(root, '100', 'a b.png', Buffer.from('覆盖'))
    await expect(readFile(saved, 'utf8')).resolves.toBe('覆盖')
    // 不同 id 各自成文件，互不覆盖。
    expect(attachmentPath(root, '101', 'a b.png')).not.toBe(saved)
  })

  it('defaultAttachmentsRoot 指向官方 cache 语义的插件子目录', () => {
    const root = defaultAttachmentsRoot()
    expect(root).toContain('cache')
    expect(root).toContain('dsh-atlassian')
  })
})
