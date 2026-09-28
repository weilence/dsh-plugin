# @weilence/dsh-notify

回合完成 / 提问 / 审批等待时弹系统桌面通知的插件；host half 提供 desktop 窗口恢复桥。

## 结构

- `src/client.tsx`：client half——`ctx.remote.$on('api-session/status')` 订阅回合完成、`ctx.uiSession.sessionStatus` 订阅 pendingInteraction diff（提问 / 审批）；`settings.section` 设置面板。
- `src/detail.ts`：通知文案组装（会话标题、多题汇总、工具名 + 原因）。
- `src/index.ts`：host half——仅 `POST /dsh-notify/activate`（spawn `dsh://open` 协议恢复 desktop 窗口）。

## 改动约定

- **host half 即使功能上 no-op 也必须保留插件行**：浏览器插件名录由 dsh-client-modules 扫描宿主 Loader 已激活条目的 `dsh.client` 声明生成——没有 host 插件行，client bundle 进不了 `window.__DSH_BOOT__`。
- 提问 / 审批监听走 `sessionStatus` 汇聚点，不直接 `$on` waterfall 事件：waterfall 监听器按注册顺序串行执行、官方 UI 的监听器阻塞到用户作答才返回，第三方插件排在链尾收不到。
- 通知不带 tag（Windows / Chromium 的 tag 语义是同 tag 静默替换，会吞掉后续横幅）；前台浏览静默逐事件采样（标签页可见且窗口聚焦时不弹）。
- 会话标题取 `sessions.list` 快照的 `displayTitle`，缺席回退「会话 + sessionId 前 8 位」。

## 陷阱

- spawn `dsh://open` 前必须从子进程环境清掉 `ELECTRON_RUN_AS_NODE`，否则 Electron 以纯 Node 模式启动、不解析协议参数。
- 投递是 best-effort、不回放：页面关闭期间的事件没有接收方；仍在等待的提问 / 审批 waterfall 会在重连后回放，页面重开时补通知一次。

## 测试

`pnpm --filter @weilence/dsh-notify test`：notify-client.test.ts（事件 diff 与文案组装）。
