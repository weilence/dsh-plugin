/** 启动行解析：宽容提取端口与 token，各种畸形输入不崩。 */

import { describe, expect, it } from 'vitest'
import { parseLaunchFromLog, parseLaunchUrl, rewriteLaunchUrl } from '../src/launch'

describe('parseLaunchUrl', () => {
  it('标准形态：127.0.0.1 + token query', () => {
    expect(parseLaunchUrl('http://127.0.0.1:4321/?token=abc123')).toEqual({
      remotePort: 4321,
      token: 'abc123',
    })
  })

  it('localhost / 额外 query 参数 / 带路径', () => {
    expect(parseLaunchUrl('http://localhost:8080/x?token=t&x=1')).toEqual({ remotePort: 8080, token: 't' })
  })

  it('缺 token、非 http、坏端口、垃圾输入都返回 undefined', () => {
    expect(parseLaunchUrl('http://127.0.0.1:4321/')).toBeUndefined()
    expect(parseLaunchUrl('https://127.0.0.1:4321/?token=t')).toBeUndefined()
    expect(parseLaunchUrl('http://127.0.0.1:0/?token=t')).toBeUndefined()
    expect(parseLaunchUrl('http://127.0.0.1:99999/?token=t')).toBeUndefined()
    expect(parseLaunchUrl('not a url')).toBeUndefined()
    expect(parseLaunchUrl('')).toBeUndefined()
  })
})

describe('parseLaunchFromLog', () => {
  it('从多行日志提取第一条启动行（容忍前后噪声）', () => {
    const log = [
      'dsh: initialized profile web at /home/u/.dsh/profiles/web',
      'cordis warn: something',
      'dsh web: http://127.0.0.1:43210/?token=TOKEN43CHARSxxxxxxxxxxxxxxxxxxxxxxxxx',
      'later noise',
    ].join('\n')
    expect(parseLaunchFromLog(log)).toEqual({
      remotePort: 43210,
      token: 'TOKEN43CHARSxxxxxxxxxxxxxxxxxxxxxxxxx',
    })
  })

  it('LAN 后缀不影响提取（取行内首个 URL）', () => {
    const log = 'dsh web: http://127.0.0.1:3080/?token=t (LAN: http://10.0.0.5:3080/?token=t)\n'
    expect(parseLaunchFromLog(log)).toEqual({ remotePort: 3080, token: 't' })
  })

  it('无启动行 / 有行但缺 token 都返回 undefined', () => {
    expect(parseLaunchFromLog('nothing here')).toBeUndefined()
    expect(parseLaunchFromLog('dsh web: http://127.0.0.1:3080/\n')).toBeUndefined()
  })
})

describe('rewriteLaunchUrl', () => {
  it('改写为本地转发端口并保留 token', () => {
    expect(rewriteLaunchUrl('http://127.0.0.1:4321/?token=abc', 19999)).toBe(
      'http://127.0.0.1:19999/?token=abc',
    )
  })

  it('坏输入返回 undefined', () => {
    expect(rewriteLaunchUrl('http://127.0.0.1:4321/', 1)).toBeUndefined()
  })
})
