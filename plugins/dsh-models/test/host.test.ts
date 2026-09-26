import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { etagMatches, isExpectedHost } from '../src/index'

function req(host?: string): IncomingMessage {
  return { headers: { host } } as IncomingMessage
}

describe('host bridge guards', () => {
  it('只允许 webServer 监听地址，端口可不同', () => {
    expect(isExpectedHost(req('127.0.0.1:3080'), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(req('127.0.0.1:9999'), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(req('localhost:3080'), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(req('[::1]:3080'), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(req('127.0.0.2:3080'), 'localhost')).toBe(true)
    expect(isExpectedHost(req('192.168.1.20:3080'), '127.0.0.1')).toBe(false)
    expect(isExpectedHost(req('user@127.0.0.1'), '127.0.0.1')).toBe(false)
  })

  it('支持 ETag 列表、弱 ETag 和通配符', () => {
    expect(etagMatches('"a", "b"', '"b"')).toBe(true)
    expect(etagMatches('W/"b"', '"b"')).toBe(true)
    expect(etagMatches('*', '"b"')).toBe(true)
    expect(etagMatches('"a"', '"b"')).toBe(false)
  })
})
