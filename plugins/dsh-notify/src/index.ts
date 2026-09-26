import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isTrustedFetch } from '@dsh-plugins/shared/http'

export const inject: string[] = ['webServer']

// Electron renderer 无法恢复最小化的 OS 窗口（window.focus() 是 no-op），因此
// 由 host half spawn dsh://open：单实例锁 → second-instance 回调 → 宿主
// focusPrimaryWindow()（与托盘「打开」同一条官方恢复路径）；Web 宿主直接返回。
function activateWindow(): void {
  // 必须清掉 ELECTRON_RUN_AS_NODE 再 spawn，子进程才会以 Electron 应用模式
  // 启动并解析协议参数，否则退化成纯 Node。
  if (process.versions.electron === undefined) return
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(process.execPath, ['dsh://open'], { env, detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    console.error('[dsh-notify] activate spawn failed', error)
  }
}

export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-notify/activate',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          // 仅认 POST：跨站预检（OPTIONS，不带 sec-fetch 头）不应触发激活。
          const allowed = req.method === 'POST' && isTrustedFetch(req)
          res.writeHead(allowed ? 204 : 403, { 'cache-control': 'no-store' })
          res.end()
          if (allowed) activateWindow()
        },
      }),
    'dsh-notify: /dsh-notify/activate route',
  )
}
