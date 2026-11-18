# dsh-notify 行为与陷阱

本文件承载 @weilence/dsh-notify 的行为规格与陷阱：插件定位、结构导览、事件订阅与通知投递语义、host 路由。

## 定位

- 回合完成 / 提问 / 审批等待时弹系统桌面通知的插件；host half 提供 desktop 窗口恢复接口。
- 仅主代理会话的完成、提问与审批会通知，子代理不通知；通知标题为会话名。
- 点击通知切换到对应会话并聚焦页面。
- 设置面板为 `settings.section` 独立「完成通知」菜单页：通知权限请求、开关与测试按钮；无持久化配置，开关为运行态。

## 结构导览

- `src/client.tsx`：client half——`ctx.remote.$on('api-session/status')` 订阅回合完成、`ctx.uiSession.sessionStatus` 订阅 pendingInteraction diff（提问 / 审批）；`settings.section` 设置面板。
- `src/detail.ts`：通知文案组装（会话标题、多题汇总、工具名 + 原因）：提问正文为首个问题文本（多题汇总数量），审批正文为「等待批准：<工具名>（<原因>）」；取词函数 `t` 由调用方传入。
- `src/client/locales.ts`：本插件词典（命名空间 `dsh-notify`）；通知文案在投递瞬间取词——桌面通知是一次性载体，不随语言切换重渲染；词典注册与 seat 机制见根 [docs/i18n.md](../../../docs/i18n.md)。
- `src/index.ts`：host half，承载下方 host 路由。

## 事件订阅与通知投递语义

- 回合完成经 `ctx.remote.$on('api-session/status')` 订阅。
- 提问 / 审批走 `ctx.uiSession.sessionStatus` 汇聚点的 pendingInteraction diff，不直接 `$on` waterfall 事件——waterfall 监听器按注册顺序串行执行、官方 UI 的监听器阻塞到用户作答才返回，第三方插件排在链尾收不到。
- 前台浏览静默按事件逐个判定：标签页可见且窗口聚焦时不弹；这类事件约 3 秒后复查一次——届时已切走则补弹，仍在前台则静默。
- 通知不带 tag：Windows / Chromium 的 tag 语义是同 tag 静默替换，会使后续横幅不再显示。
- 会话标题取 `sessions.list` 快照的 `displayTitle`，缺失时回退词典键 `session.fallback`（会话 + sessionId 前 8 位）。
- 投递是 best-effort、不回放：页面关闭期间的事件没有接收方，连接短暂中断期间的完成事件会丢失；仍在等待的提问 / 审批 waterfall 会在重连后回放，页面重开时补通知一次。

## host 路由

- `POST /dsh-notify/activate`：spawn `dsh://open` 协议恢复 desktop 窗口，即点击通知切回对应会话的落点；spawn 前必须从子进程环境清掉 `ELECTRON_RUN_AS_NODE`，否则 Electron 以纯 Node 模式启动、不解析协议参数。

## 陷阱

- 组件 props 的 `t` 用本插件窄类型 `NotifyT`（`TranslateNS<'dsh-notify'>`），不要用宽域 `Translate`（缘由见根 [docs/i18n.md](../../../docs/i18n.md)）；单测取词用 `test/i18n.ts` 的 `makeT`。
