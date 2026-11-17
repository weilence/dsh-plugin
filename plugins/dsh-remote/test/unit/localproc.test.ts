import { describe, expect, it } from 'vitest'
import {
  codepageLabel,
  decodeLocalOutput,
  parseCodepageOutput,
  resolveWindowsCommand,
  resolveWindowsPnpm,
} from '../../src/localproc'

// GBK(936) 字面字节：'不是内部或外部命令'（.NET 936 编码器实证生成）。
const GBK_NOT_FOUND = Buffer.from([
  0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf, 0xbb, 0xf2, 0xcd, 0xe2, 0xb2, 0xbf, 0xc3, 0xfc, 0xc1, 0xee,
])
const NOT_FOUND_TEXT = '不是内部或外部命令'

describe('decodeLocalOutput', () => {
  it('win32 + 936：GBK 字节解出原文', () => {
    expect(decodeLocalOutput([GBK_NOT_FOUND], true, 936)).toBe(NOT_FOUND_TEXT)
  })

  it('UTF-8 字节不被回退误转', () => {
    const chunks = [Buffer.from('pnpm pack 失败：ERR_PNPM_离谱', 'utf8')]
    expect(decodeLocalOutput(chunks, true, 936)).toBe('pnpm pack 失败：ERR_PNPM_离谱')
  })

  it('代码页 65001 / 未知值 / null：保持 UTF-8 原样', () => {
    for (const codepage of [65001, 99999, null]) {
      expect(decodeLocalOutput([GBK_NOT_FOUND], true, codepage)).toBe(GBK_NOT_FOUND.toString('utf8'))
    }
  })

  it('非 win32 不做代码页回退', () => {
    expect(decodeLocalOutput([GBK_NOT_FOUND], false, 936)).toBe(GBK_NOT_FOUND.toString('utf8'))
  })
})

describe('codepageLabel', () => {
  it('常见 CJK / 西文码页映射', () => {
    expect(codepageLabel(936)).toBe('gbk')
    expect(codepageLabel(950)).toBe('big5')
    expect(codepageLabel(932)).toBe('shift_jis')
    expect(codepageLabel(949)).toBe('euc-kr')
    expect(codepageLabel(1252)).toBe('windows-1252')
    expect(codepageLabel(850)).toBe('windows-1252')
  })

  it('65001 与未知码页归 null（不回退）', () => {
    expect(codepageLabel(65001)).toBeNull()
    expect(codepageLabel(99999)).toBeNull()
  })
})

describe('parseCodepageOutput', () => {
  it('解析本地化标签里的 ASCII 数字', () => {
    expect(parseCodepageOutput('活动代码页: 936\r\n')).toBe(936)
    expect(parseCodepageOutput('Active code page: 65001\r\n')).toBe(65001)
  })

  it('无数字 / 空输出回 null', () => {
    expect(parseCodepageOutput('garbage without digits')).toBeNull()
    expect(parseCodepageOutput('')).toBeNull()
  })
})

describe('resolveWindowsCommand', () => {
  const existsOf = (present: string[]) => (path: string) => present.includes(path)

  it('目录优先于扩展名（与 PATH 语义一致）', () => {
    const resolved = resolveWindowsCommand(
      'tool',
      ['C:\\a', 'C:\\b'],
      ['.exe', '.cmd'],
      existsOf(['C:\\a\\tool.cmd', 'C:\\b\\tool.exe']),
    )
    expect(resolved).toBe('C:\\a\\tool.cmd')
  })

  it('跳过缺失项与空目录段，全缺回 null', () => {
    expect(
      resolveWindowsCommand('tool', ['C:\\a', '', 'C:\\b'], ['.exe', '.cmd'], existsOf(['C:\\b\\tool.exe'])),
    ).toBe('C:\\b\\tool.exe')
    expect(resolveWindowsCommand('tool', ['C:\\a'], ['.exe'], existsOf([]))).toBeNull()
  })
})

describe('resolveWindowsPnpm', () => {
  it('按 PATH 找到绝对路径', () => {
    expect(resolveWindowsPnpm('C:\\x;C:\\y', (path) => path === 'C:\\y\\pnpm.exe')).toBe('C:\\y\\pnpm.exe')
  })

  it('找不到 / PATH 缺失回 null', () => {
    expect(resolveWindowsPnpm('C:\\x', () => false)).toBeNull()
    expect(resolveWindowsPnpm(undefined)).toBeNull()
    expect(resolveWindowsPnpm('')).toBeNull()
  })
})
