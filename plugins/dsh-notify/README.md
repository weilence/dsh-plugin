# dsh-notify

DSH web 插件 —— 回合完成通知。模型回合处理完成时弹操作系统级桌面通知，
离开页面也能第一时间知道「跑完了」。

## 功能

- **系统通知（纯 client 实现，无自建传输）**：client 侧 `ctx.remote.$on`
  直接订阅宿主转发的 `api-session/status` 全局事件（官方
  `API_REMOTE_FORWARDED_EVENTS` 白名单内），`running` 归还 `false` 即本回合
  处理完成，经宿主 Remote 通道（`/api/remote.mux` WebSocket，desktop 走
  IPC/进程内载体）实时推送，无轮询、近乎零延迟；用 Notification API 弹
  系统级通知（Windows 通知中心）。**不带 tag**：Windows/Chromium 的 tag
  语义是同 tag 静默替换，首个通知被收进中心后同 tag 的后续通知不再弹
  横幅。点击通知经 `ctx.uiWorkspace.openSession` 切换到对应会话并聚焦
  页面（web 宿主自动聚焦；desktop 的 renderer 无法恢复最小化窗口，
  手动恢复时已停在正确会话）。
- **提问等待回答通知**：模型 `ask_user_question` 发起提问（含 `exit_plan_mode`
  计划审批）等待用户回答时同样通知，正文为首个问题文本（多题汇总数量）。
  经 `ctx.uiSession.sessionStatus` 的 `pendingInteraction` 变化触发——官方
  UI 插件收到转发 waterfall 后同步注册 pending interaction，快照随事件到达
  同一 tick 更新。不直接 `$on` 这两个 waterfall 事件的原因：waterfall 监听器
  按注册顺序串行执行，官方 UI 的监听器阻塞到用户作答才返回，第三方插件
  加载在官方 UI 之后、排在链尾，正常作答路径下不会被调用；
  `sessionStatus` 是这些事件的公开汇聚点，语义等价且不受加载顺序影响。
- **工具审批等待批准通知**：工具操作需要用户批准（命令执行审批、沙箱提权、
  工作区外写入等）时通知，正文为「等待批准：<工具名> · <原因>」。同样经
  `sessionStatus` 的 pendingInteraction（`approval` 域）触发。
- **前台浏览时静默（固定行为）**：您正停留在本页（标签页可见且窗口聚焦）时
  不弹通知，切走标签页或最小化后自动恢复。逐事件采样（事件到达即判定）。
- **设置页面**：设置面板新增独立「完成通知」菜单页——通知权限请求、
  开关与测试按钮。
- 任意会话（含子代理）完成均会通知，通知标题为会话名
  （`sessions.list` 的 `displayTitle`：durable title → 工作区目录名 →
  id 回退）。

### 投递语义（与旧长轮询实现的差异）

转发事件为 best-effort、不回放：页面关闭期间的事件没有接收方、不会补发；
连接闪断期间的完成事件会丢失（旧实现的 seq 游标 + 100 条环形缓冲可补发，
此能力随自建传输一并移除）。仍在等待的提问/审批 waterfall 会在重连后回放，
因此页面重开时「等待回答/批准」仍会补通知一次。

## 安装

宿主 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 均加入
`dsh-notify`。启动时 profile boot 会自动合并包内的 `cordis.patch.yml`，
把插件插入 host composition。

## 使用

安装重启后打开 Web UI 设置 →「完成通知」：

1. 首次使用点「请求通知权限」并在浏览器弹窗中允许（插件激活时通常也会
   自动请求一次）；
2. 保持开关为「通知：开」；
3. 「测试」按钮可立即验证系统通知。

注意：浏览器页面需保持打开，页面关闭即无接收方；若系统级收不到通知，
先检查操作系统对浏览器的通知授权。

## 工作原理

```
client half (src/client.tsx) — 纯 client，host half 为 no-op 占位
  ctx.remote.$on('api-session/status')        （转发的 emit 事件）
    → running 归还 false → 通知「模型处理已完成」
  ctx.uiSession.sessionStatus.subscribe()     （公开 observable）
    → diff pendingInteraction：新增 key → 通知「等待您的回答 / 等待批准」
      （官方 UI 收到转发 waterfall 后同步注册，与事件到达同一 tick）
  settings.section → 设置页「完成通知」控制面板
```

host half（src/index.ts）保留空入口的原因：浏览器插件名录由
`dsh-client-modules` 的 node half 扫描宿主 Loader 中已激活条目的
`dsh.client` 声明生成，本包需要作为 host 插件行正常加载，`dsh.client`
字段才会进入 `window.__DSH_BOOT__` 名录。

无配置项。会话标题取自 `ctx.sessions.list` 快照的 `displayTitle`，
缺席时回退「会话 + sessionId 前 8 位」。

## 开发

```bash
pnpm install        # 安装依赖
pnpm build          # 构建产物到 lib/（tsdown，双 half）
pnpm watch          # 监听式构建
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest 单测
```

宿主契约类型全部取自官方 npm 包的 **type-only 导入**（声明合并进
`@deepseek-ai/cordis` 的 `Context`/`Events` 接口），编译产物保持零运行时
导入。来源与版本（对齐运行宿主 0.1.7-rc.2，npm dist-tag `next`）：

| 契约 | 官方包 |
| --- | --- |
| `Context` / `effect` / `ctx.get` | `@deepseek-ai/cordis` |
| `ctx.remote` / `$on` 键面与载荷 | `@deepseek-ai/dsh-api-remotes/client` |
| `ctx.uiSession` / `sessionStatus` / `SessionPendingInteractionBase` | `@deepseek-ai/dsh-client-ui-session/client` |
| `ctx.sessions` / `displayTitle` | `@deepseek-ai/dsh-api-session-controller/client` |
| `ctx.slots`（client） | `@deepseek-ai/dsh-client-ui-renderer/client` |
| `settings.section` 槽位契约（client） | `@deepseek-ai/dsh-client-ui-settings/client` |
| `SessionId` | `@deepseek-ai/dsh-session` |
| `AskUserQuestionItem` | `@deepseek-ai/dsh-user-questions/types` |

本地接入运行中的宿主：宿主 `package.json` 以 `file:../dsh-notify` 方式
加入 `dependencies` 与 `dsh.profile.bundles`，`pnpm build` 后重启宿主即可。

## 许可证

MIT
