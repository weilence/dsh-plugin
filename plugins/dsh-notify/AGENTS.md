# @weilence/dsh-notify

回合完成 / 提问 / 审批等待时弹系统桌面通知的插件；host half 提供 desktop 窗口恢复接口。

## 结构

- `src/client.tsx`：client half——`ctx.remote.$on('api-session/status')` 订阅回合完成、`ctx.uiSession.sessionStatus` 订阅 pendingInteraction diff（提问 / 审批）；`settings.section` 设置面板。
- `src/detail.ts`：通知文案组装（会话标题、多题汇总、工具名 + 原因），取词函数 `t` 由调用方传入。
- `src/client/locales.ts`：本插件词典（命名空间 `dsh-notify`，zh 为键集事实源、en 编译期查全），client `apply` 经 `ctx.locale.register` 注册；面板的 `t` 由 slot 注册声明 `locale: NS` 的框架标准 seat 合成进 props（apply 域 `bind` 服务事件路径与导航 label thunk）。通知文案在投递瞬间取词——桌面通知是一次性载体，不随语言切换重渲染。
- `src/index.ts`：host half——仅 `POST /dsh-notify/activate`（spawn `dsh://open` 协议恢复 desktop 窗口）。

## 改动约定

- **host half 接近 no-op 也不得删插件行**——client bundle 进 boot 依赖宿主已激活的插件行（机制见根「双 half 架构」）。
- 提问 / 审批监听走 `sessionStatus` 汇聚点，不直接 `$on` waterfall 事件：waterfall 监听器按注册顺序串行执行、官方 UI 的监听器阻塞到用户作答才返回，第三方插件排在链尾收不到。
- 通知不带 tag（Windows / Chromium 的 tag 语义是同 tag 静默替换，会使后续横幅不再显示）；前台浏览静默按事件逐个判定（标签页可见且窗口聚焦时不弹）。
- 会话标题取 `sessions.list` 快照的 `displayTitle`，缺失时回退词典键 `session.fallback`（会话 + sessionId 前 8 位）。

## 陷阱

- spawn `dsh://open` 前必须从子进程环境清掉 `ELECTRON_RUN_AS_NODE`，否则 Electron 以纯 Node 模式启动、不解析协议参数。
- 投递是 best-effort、不回放：页面关闭期间的事件没有接收方；仍在等待的提问 / 审批 waterfall 会在重连后回放，页面重开时补通知一次。
- 组件 props 的 `t` 用本插件窄类型 `NotifyT`（`TranslateNS<'dsh-notify'>`），不要用宽域 `Translate`——函数参数逆变，窄域不可赋给宽域；单测取词用 `test/i18n.ts` 的 `makeT`。

## 测试

`pnpm --filter @weilence/dsh-notify test`：notify-client.test.ts（事件 diff 与文案组装）、notify-events.test.ts（事件路径集成，locale 服务用 register/bind 替身）。
