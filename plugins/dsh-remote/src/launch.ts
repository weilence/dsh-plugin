export interface RemoteLaunch {
  /** 实例实际监听的端口（--port 0 时由 OS 分配）。 */
  remotePort: number
  /** 鉴权 token（重启必换）。 */
  token: string
}

const LAUNCH_LINE = /^dsh web: (\S+)/m

/** 从日志文本中提取第一条启动行并解析 URL；无有效行（或缺 token）返回 undefined。 */
export function parseLaunchFromLog(log: string): RemoteLaunch | undefined {
  const match = LAUNCH_LINE.exec(log)
  return match === null ? undefined : parseLaunchUrl(match[1])
}

/** 宽容解析单个 URL：任意 host 都改写为 127.0.0.1 语义（端口转发目标）。 */
export function parseLaunchUrl(raw: string): RemoteLaunch | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:') return undefined
  const remotePort = Number(url.port)
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) return undefined
  const token = url.searchParams.get('token') ?? ''
  if (token.length === 0) return undefined
  return { remotePort, token }
}

/** 用本地转发端口重写启动 URL（token 原样保留）。 */
export function rewriteLaunchUrl(rawTokenUrl: string, localPort: number): string | undefined {
  const launch = parseLaunchUrl(rawTokenUrl)
  if (launch === undefined) return undefined
  return `http://127.0.0.1:${localPort}/?token=${launch.token}`
}
