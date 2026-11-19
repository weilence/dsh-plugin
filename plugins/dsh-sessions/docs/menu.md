# dsh-sessions 菜单与弹窗域

本文件承载菜单与弹窗域——会话行「…」菜单条目与弹窗分发（`src/client.tsx`、`src/client/*`，host 侧路由见 docs/surgery.md）——的行为语义、陷阱与取舍。磁盘手术域见 [docs/surgery.md](surgery.md)，测试地图见 [docs/tests.md](tests.md)。

## 菜单条目

- 侧栏会话行「…」菜单（官方 `sidebar.workspaces.session.menu.item` 槽位）提供两项，均带前置图标：迁移到工作区（`IconWorkspaceTreeOutlineRegular`）、迁移预设（`IconAgentPresetOutlineRegular`）；官方内置条目（置顶 / 重命名 / 分叉 / 复制 ID / 归档·恢复 / 删除类日常操作）由宿主提供，本插件不重复。
- 菜单条目组件在打开时读官方会话快照做前置闸门：子会话禁用两项迁移；官方行快照 `running`（回合进行中）或 `retainedBy` 任一来源计数大于零（本客户端正持有引用，含正在查看）时，会话必然已加载，同样禁用并给「已加载」原因。快照未及加载或盲区（已加载但空闲且未被本客户端持有，如刷新页面前已打开、或另一窗口加载）时条目保持可用，弹窗探针与 host 侧闸门仍会拦——客户端闸门只是前置反馈，不是安全边界。
- 宿主对打开过的会话长期持有（官方 RPC 面没有卸载入口，归档只停活动不清内存），因此已加载的唯一出路是重启宿主；禁用原因与弹窗提示都只指向重启。
- 行身份的 `displayTitle` 无标题时为空串，弹窗标题与会话 ID 兜底。
- 归档会话在侧栏按归档过滤灰显可见，两项操作对归档会话同样可用（归档会话不在宿主内存中，天然满足闸门）。

## 弹窗分发

- 行随菜单关闭而卸载，弹窗必须挂在行外：两项操作共用一个请求桥（`src/client/requests.ts`），`shell.overlay` 常驻条目（`src/client/dialogs.tsx`）按 `kind` 分发迁移弹窗 / 预设弹窗，请求按 `kind:sessionId` 换 key 重挂。
- 两弹窗打开时各探一次官方 `session.state`（`src/client/loaded.ts` 的 `useLoadProbe`，经注入面携带 `ctx.remote` 探针）：`active` ⇔ 宿主为该会话持有活 agent，与 host 侧 `assertNotLoaded` 所查的官方 `SessionStore` 同源等价，且读取是被动读、不激活会话。`active` 为真时禁用确认按钮并给行内常驻原因；探测期间禁用提交；探测失败按「未知」放行（网络/异常场景不误伤），host 侧守卫继续兜底。探针随弹窗重挂重新执行，不做弹窗存续期订阅（提交与确认之间的窗口由 host 侧守卫拦截）。
- 成功反馈的横幅由常驻条目自身持有（`src/client/dialogs.tsx` 的 `success` 态）：Toast 经 body portal 渲染、视觉位置与宿主无关，但 React 归属决定存活——弹窗成功（含归属未完成的补救指引）后自关，横幅挂在不随弹窗卸载的条目上播完 5 秒自清（官方 plugin-manager 的 PluginRefreshToast 同款模式）；nonce 作 key，同文案连续成功也重开计时。
- 失败与校验反馈行内常驻于弹窗 footer（`role="alert"`，重试或改选时清空），弹窗保持打开供直接重试——与仓库根 docs/panel.md 的通道约定一致（成功走 Toast、错误与校验反馈行内常驻、失败原因不随弹窗消失）。
- 通知通道划分通则见仓库根 docs/panel.md；跨语言切换须存活的提示用消息描述子 `{key, params} | {text}`，渲染期取词（见仓库根 docs/i18n.md）。

## 会话列表刷新

- 迁移成功后客户端全量刷新官方会话列表（`sessions.refresh`）；刷新失败提示刷新页面查看新工作区。

## 官方快照事实

- 菜单闸门全部来自官方客户端快照（`useSessions` 全局标准席位），不读聊天内容；subagent 回退行仅存在于 byId。
