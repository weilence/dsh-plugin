// dsh-notify — host half（窗口恢复桥）。
// 构建产物 lib/ 由 tsdown 生成（pnpm build），不要直接编辑。
//
// 职责：为 client 提供唯一的「激活应用窗口」接口 POST /dsh-notify/activate。
//
// 为什么需要它：desktop 上 Electron renderer 无法恢复最小化的 OS 窗口——
// window.focus() 在 renderer 是 no-op，location.href 的外部协议导航被
// Electron 静默丢弃（不可导航 scheme 不走 shell 分流）。而本 half 运行在
// desktop-host（Node）进程里，可以直接以干净环境 spawn dsh://open 协议：
// OS 启动新实例 → 单实例锁 → second-instance 回调 → 宿主既有的
// focusPrimaryWindow()（与托盘「打开」同一条官方恢复路径，尊重
// welcome/强制更新等窗口状态门控）。
//
// Web 宿主：浏览器点击通知自带应用激活，本接口为 204 no-op（未运行在
// Electron 二进制下时跳过 spawn）。
//
// 安全：恢复窗口是低敏感动作；防跨站骚扰有两层——浏览器对带自定义头的
// 跨站 POST 强制 CORS 预检（本路由不应答预检，跨站请求到不了 handler），
// handler 侧再拒绝 sec-fetch-site: cross-site。
//
// 另：浏览器插件名录由 dsh-client-modules 的 node half 扫描宿主 Loader 中
// 已激活条目的 dsh.client 声明生成——本包作为 host 插件行加载（cordis.patch.yml
// 插入，main = lib/index.js），package.json 的 dsh.client 字段才会进入
// window.__DSH_BOOT__ 名录。

import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// ctx.webServer（WebServer，register(route: WebRoute)）：
import type {} from '@deepseek-ai/dsh-host-webserver'

export const inject: string[] = ['webServer']

function isTrusted(req: IncomingMessage): boolean {
	const site = req.headers['sec-fetch-site']
	return site === undefined || site === 'same-origin' || site === 'none'
}

function activateWindow(): void {
	// 仅 desktop-host 适用：以 Electron 二进制运行的 Node（ELECTRON_RUN_AS_NODE=1）。
	// 必须清掉该变量再 spawn——子进程才会以 Electron 应用模式启动并解析协议参数；
	// 否则 exe 退化成纯 Node，把 dsh://open 当脚本路径加载（实测 MODULE_NOT_FOUND）。
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
					const allowed = req.method === 'POST' && isTrusted(req)
					res.writeHead(allowed ? 204 : 403, { 'cache-control': 'no-store' })
					res.end()
					if (allowed) activateWindow()
				},
			}),
		'dsh-notify: /dsh-notify/activate route',
	)
}
