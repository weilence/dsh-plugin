import type { Context } from '@deepseek-ai/cordis'
import { expectTypeOf, it } from 'vitest'
import type { RemoteTransport, RemoteTransportConnection, RemoteTransportPath } from '../src/remote'

it('共享声明是唯一的 Cordis 远端传输契约', () => {
  expectTypeOf<Context['remoteTransport']>().toEqualTypeOf<RemoteTransport>()
  expectTypeOf<ReturnType<RemoteTransport['listConnections']>>().toEqualTypeOf<RemoteTransportConnection[]>()
  expectTypeOf<RemoteTransportPath>().toEqualTypeOf<'/dsh-sessions/preview' | '/dsh-sessions/import'>()
  expectTypeOf<ReturnType<RemoteTransport['request']>>().toEqualTypeOf<Promise<unknown>>()
})
