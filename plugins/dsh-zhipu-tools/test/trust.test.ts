// index.ts 同源防护单测：/usage 路由的 403 门（isTrusted / isLoopbackHostname）。

import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isLoopbackHostname, isTrusted } from '../src/index'

function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as IncomingMessage
}

describe('isLoopbackHostname', () => {
  it.each(['localhost', '::1', '[::1]', '127.0.0.1', '127.1.2.3'])('%s 视为 loopback', (host) => {
    expect(isLoopbackHostname(host)).toBe(true)
  })

  it.each(['example.com', '0.0.0.0', '128.0.0.1', '127.0.0', '1270.0.0.1', '127.256.0.1', ''])(
    '%s 不视为 loopback',
    (host) => {
      expect(isLoopbackHostname(host)).toBe(false)
    },
  )
})

describe('isTrusted', () => {
  it('loopback 无 origin（同源导航/fetch 省略 origin）放行', () => {
    expect(isTrusted(req({ host: '127.0.0.1:3080' }))).toBe(true)
    expect(isTrusted(req({ host: 'localhost:3080' }))).toBe(true)
    expect(isTrusted(req({ host: '[::1]:3080' }))).toBe(true)
  })

  it('非 loopback host 拒绝', () => {
    expect(isTrusted(req({ host: 'example.com:80' }))).toBe(false)
  })

  it('缺 host 拒绝', () => {
    expect(isTrusted(req({}))).toBe(false)
  })

  it('sec-fetch-site: cross-site 拒绝', () => {
    expect(isTrusted(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }))).toBe(false)
  })

  it('origin 与 host 同源放行', () => {
    expect(isTrusted(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBe(true)
  })

  it('origin 与 host 不一致拒绝', () => {
    expect(isTrusted(req({ host: '127.0.0.1:3080', origin: 'http://evil.example' }))).toBe(false)
  })

  it('非法 origin 拒绝', () => {
    expect(isTrusted(req({ host: '127.0.0.1:3080', origin: 'http://' }))).toBe(false)
  })
})
