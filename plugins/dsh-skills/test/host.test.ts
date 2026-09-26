import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isExpectedHost, isTrustedFetch } from '../src/index'

function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('isExpectedHost', () => {
  it('精确匹配放行', () => {
    expect(isExpectedHost(req({ host: '127.0.0.1:8080' }), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(req({ host: 'localhost:8080' }), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(req({ host: '[::1]:8080' }), '127.0.0.1')).toBe(true)
    expect(isExpectedHost(req({ host: '127.8.8.8:8080' }), 'localhost')).toBe(true)
  })

  it('非 loopback 的 Host 头拒绝', () => {
    expect(isExpectedHost(req({ host: 'evil.example:8080' }), '127.0.0.1')).toBe(false)
    expect(isExpectedHost(req({ host: '127.0.0.1.evil.example' }), '127.0.0.1')).toBe(false)
  })

  it('畸形 Host 头拒绝', () => {
    expect(isExpectedHost(req({}), '127.0.0.1')).toBe(false)
    expect(isExpectedHost(req({ host: 'a/b@example.com' }), '127.0.0.1')).toBe(false)
    expect(isExpectedHost(req({ host: 'not a host' }), '127.0.0.1')).toBe(false)
  })
})

describe('isTrustedFetch', () => {
  it('同源与头缺席（dsh-app: 协议）放行', () => {
    expect(isTrustedFetch(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(isTrustedFetch(req({}))).toBe(true)
    expect(isTrustedFetch(req({ 'sec-fetch-site': 'none' }))).toBe(true)
  })

  it('跨站标记拒绝', () => {
    expect(isTrustedFetch(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isTrustedFetch(req({ 'sec-fetch-site': 'same-site' }))).toBe(false)
  })
})
