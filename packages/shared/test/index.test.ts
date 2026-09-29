import { describe, expect, it } from 'vitest'
import { errMsg } from '../src/index'

describe('errMsg', () => {
  it('Error 实例取 message', () => {
    expect(errMsg(new Error('boom'))).toBe('boom')
    expect(errMsg(new TypeError('bad type'))).toBe('bad type')
  })

  it('非 Error 但带真值 message 的对象取 message（鸭子类型）', () => {
    expect(errMsg({ message: 'duck' })).toBe('duck')
  })

  it('字符串与无 message 对象退回 String()', () => {
    expect(errMsg('raw')).toBe('raw')
    expect(errMsg(null)).toBe('null')
    expect(errMsg(undefined)).toBe('undefined')
    expect(errMsg({})).toBe('[object Object]')
  })

  it('空 message 的 Error 退回 String(error)', () => {
    // String(new Error('')) === 'Error'
    expect(errMsg(new Error(''))).toBe('Error')
  })
})
