import { describe, expect, it } from 'vitest'
import { BoundedCapture, displayCommand, glabCandidates } from '../../src/glab'

describe('BoundedCapture', () => {
  it('未超头部容量时全量保留，不标截断', () => {
    const capture = new BoundedCapture()
    capture.push('abc')
    expect(capture.text()).toBe('abc')
    expect(capture.truncated).toBe(false)
  })

  it('头部填满后同 chunk 余量进尾部', () => {
    const capture = new BoundedCapture()
    // 一段正好填满头部：余量必须落尾而不是丢
    capture.push('a'.repeat(16_000) + 'b'.repeat(3))
    expect(capture.text()).toBe('a'.repeat(16_000) + 'bbb')
    expect(capture.truncated).toBe(false)
  })

  it('溢出后滚动保留尾部并标截断', () => {
    const capture = new BoundedCapture()
    capture.push('a'.repeat(16_000))
    capture.push('b'.repeat(20_000))
    capture.push('c'.repeat(5))
    expect(capture.text()).toBe('a'.repeat(16_000) + 'b'.repeat(15_995) + 'ccccc')
    expect(capture.truncated).toBe(true)
  })

  it('恰好填满头尾之和不算截断（内容无丢失）', () => {
    const capture = new BoundedCapture()
    capture.push('a'.repeat(16_000))
    capture.push('b'.repeat(16_000))
    expect(capture.truncated).toBe(false)
  })
})

describe('displayCommand', () => {
  it('普通 token 原样拼接', () => {
    expect(displayCommand(['mr', 'list', '-R', 'group/repo'])).toBe('mr list -R group/repo')
  })

  it('含空白或单引号的项单引号包裹并转义', () => {
    expect(displayCommand(['api', 'some field'])).toBe(`api 'some field'`)
    expect(displayCommand(["it's"])).toBe(`'it'\\''s'`)
  })
})

describe('glabCandidates', () => {
  it('显式 glabPath 最优先', () => {
    const candidates = glabCandidates('/custom/glab', { PATH: '/bin' }, 'darwin')
    expect(candidates[0]).toEqual({ path: '/custom/glab', bare: false })
  })

  it('惯例位置在前、PATH 逐目录随后、裸命令名兜底且全表去重', () => {
    const candidates = glabCandidates(undefined, { PATH: '/opt/homebrew/bin:/bin' }, 'darwin')
    const paths = candidates.map((candidate) => candidate.path)
    expect(paths[0]).toBe('/opt/homebrew/bin/glab')
    expect(paths[1]).toBe('/usr/local/bin/glab')
    expect(paths[2]).toBe('/usr/bin/glab')
    expect(paths).toContain('/bin/glab')
    // /opt/homebrew/bin 既在惯例位置也在 PATH 里：只出现一次
    expect(paths.filter((path) => path === '/opt/homebrew/bin/glab')).toHaveLength(1)
    expect(candidates.at(-1)).toEqual({ path: 'glab', bare: true })
  })

  it('win32 用 glab.exe', () => {
    const candidates = glabCandidates(undefined, {}, 'win32')
    expect(candidates[0]?.path).toBe('/opt/homebrew/bin/glab.exe')
    expect(candidates.at(-1)?.path).toBe('glab.exe')
  })

  it('空 PATH 与空配置不产生空项', () => {
    const candidates = glabCandidates('  ', { PATH: '' }, 'linux')
    expect(candidates.some((candidate) => candidate.path.trim() === '')).toBe(false)
  })
})
