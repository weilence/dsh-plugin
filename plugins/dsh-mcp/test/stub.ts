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
