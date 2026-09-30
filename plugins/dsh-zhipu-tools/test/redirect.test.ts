import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { createZhipuSearchProvider } from '../src/search'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('测试服务器未绑定端口')
  return `http://127.0.0.1:${address.port}`
}

it('携带 Bearer 凭据的 MCP 请求不跟随重定向', async () => {
  let targetRequests = 0
  const target = await listen(
    createServer((_request, response) => {
      targetRequests++
      response.end('redirect target')
    }),
  )
  let initialAuthorization: string | undefined
  const source = await listen(
    createServer((request, response) => {
      initialAuthorization = request.headers.authorization
      response.writeHead(307, { location: target })
      response.end()
    }),
  )

  const provider = createZhipuSearchProvider(async () => 'only-for-source', `${source}/mcp`)
  await expect(provider.search({ query: '安全测试' })).rejects.toThrow()
  expect(initialAuthorization).toBe('Bearer only-for-source')
  expect(targetRequests).toBe(0)
})
