/** host 栅栏：loopback 判定、Host 头守卫、sec-fetch-site 守卫、JSON 桥读写。 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  HttpError,
  MAX_BODY_BYTES,
  isExpectedHost,
  isLoopbackHostname,
  isTrustedFetch,
  readJsonBody,
  writeJson,
} from '../src/http'

function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('isLoopbackHostname', () => {
  it('localhost / 127.x / ::1 的各拼写都识别', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.8.8.8')).toBe(true)
    expect(isLoopbackHostname('127.255.255.255')).toBe(true)
    expect(isLoopbackHostname('::1')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('0:0:0:0:0:0:0:1')).toBe(true)
  })

  it('非 loopback 与残缺输入拒绝', () => {
    expect(isLoopbackHostname('example.com')).toBe(false)
    expect(isLoopbackHostname('128.0.0.1')).toBe(false)
    expect(isLoopbackHostname('127.0.0.1.evil.example')).toBe(false)
    expect(isLoopbackHostname('127.0.0')).toBe(false)
    expect(isLoopbackHostname('127.256.0.1')).toBe(false)
    expect(isLoopbackHostname('127.999.0.1')).toBe(false)
    expect(isLoopbackHostname('localhost.')).toBe(false)
    expect(isLoopbackHostname('')).toBe(false)
  })
})

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

describe('writeJson', () => {
  it('写状态、JSON 头与 no-store，负载为 UTF-8 JSON', () => {
    const captured: { status?: number; headers?: Record<string, string>; payload?: Buffer } = {}
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        captured.status = status
        captured.headers = headers
      },
      end(payload?: Buffer) {
        captured.payload = payload
      },
    } as unknown as ServerResponse
    writeJson(res, 403, { error: 'forbidden' })
    expect(captured.status).toBe(403)
    expect(captured.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    expect(captured.headers?.['content-length']).toBe(String(captured.payload?.byteLength))
    expect(JSON.parse((captured.payload ?? Buffer.alloc(0)).toString('utf8'))).toEqual({ error: 'forbidden' })
  })
})

describe('readJsonBody', () => {
  function bodyReq(chunks: Buffer[]): IncomingMessage {
    const stream = (async function* () {
      yield* chunks
    })()
    return {
      headers: {},
      method: 'POST',
      url: '/',
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    } as unknown as IncomingMessage
  }

  async function expectHttpError(promise: Promise<unknown>): Promise<HttpError> {
    try {
      await promise
    } catch (error) {
      return error as HttpError
    }
    throw new Error('expected HttpError')
  }

  it('多块拼接为 JSON 对象', async () => {
    const half = JSON.stringify({ a: 1 })
    const parsed = await readJsonBody(bodyReq([Buffer.from(half.slice(0, 3)), Buffer.from(half.slice(3))]))
    expect(parsed).toEqual({ a: 1 })
  })

  it('空请求体 400', async () => {
    const error = await expectHttpError(readJsonBody(bodyReq([])))
    expect(error).toBeInstanceOf(HttpError)
    expect(error.status).toBe(400)
  })

  it('数组与非法 JSON 400', async () => {
    expect((await expectHttpError(readJsonBody(bodyReq([Buffer.from('[1,2]')])))).status).toBe(400)
    expect((await expectHttpError(readJsonBody(bodyReq([Buffer.from('not json')])))).status).toBe(400)
  })

  it('超过 MAX_BODY_BYTES 413', async () => {
    const error = await expectHttpError(readJsonBody(bodyReq([Buffer.alloc(MAX_BODY_BYTES + 1)])))
    expect(error.status).toBe(413)
  })
})
