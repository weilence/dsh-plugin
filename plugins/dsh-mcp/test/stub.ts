import type { McpConfigDraft } from '../src/shared'

/** 应答 initialize 的最小 stdio 服务器脚本（node -e）：读完一行回一行 JSON-RPC response。 */
export const STUB_INITIALIZER = `
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    const index = buffer.indexOf('\\n')
    if (index < 0) return
    const message = JSON.parse(buffer.slice(0, index))
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n')
    buffer = buffer.slice(index + 1)
  })
`

/** 以当前 node 为 stdio 桩服务器；probe 的 spawn 与官方同款（cross-spawn、args 直传），内联脚本原样到达。 */
export const stdioConfig = (script: string): McpConfigDraft => ({
  transport: 'stdio',
  serverName: 'stub',
  command: process.execPath,
  args: ['-e', script],
})
