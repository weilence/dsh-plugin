import type {} from '@deepseek-ai/cordis'

export type RemoteTransportPath = '/dsh-sessions/preview' | '/dsh-sessions/import'

export type RemoteTransportUnavailableReason =
  'disconnected' | 'busy' | 'connecting' | 'stopping' | 'error' | 'invalid-tunnel'

export interface RemoteTransportConnection {
  id: string
  label: string
  available: boolean
  reason?: RemoteTransportUnavailableReason
  detail?: string
}

/** 插件间的受限 JSON 通道，不接受 URL、HTTP 方法或认证材料。 */
export interface RemoteTransport {
  listConnections(): RemoteTransportConnection[]
  request(id: string, path: RemoteTransportPath, body: unknown): Promise<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteTransport: RemoteTransport
  }
}
