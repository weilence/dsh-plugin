# dsh-sessions 菜单与弹窗域

本文件承载菜单与弹窗域——会话行「…」菜单条目与弹窗分发（`src/client.tsx`、`src/client/*`，host 侧路由见 docs/surgery.md）——的行为语义、陷阱与取舍。磁盘手术域见 [docs/surgery.md](surgery.md)，测试地图见 [docs/tests.md](tests.md)。

## 菜单条目

- 侧栏会话行「…」菜单（官方 `sidebar.workspaces.session.menu.item` 槽位）提供两项，均带前置图标：迁移到工作区（`IconWorkspaceTreeOutlineRegular`）、迁移预设（`IconAgentPresetOutlineRegular`）；官方内置条目（置顶 / 重命名 / 分叉 / 复制 ID / 归档·恢复 / 删除类日常操作）由宿主提供，本插件不重复。
- 菜单条目组件在打开时读官方会话快照做前置闸门：子会话禁用两项迁移（`disabledReason` 说明原因）。快照未及加载时条目保持可用，host 侧闸门仍会拒绝——客户端闸门只是前置反馈，不是安全边界。
- 行身份的 `displayTitle` 无标题时为空串，弹窗标题与会话 ID 兜底。
- 归档会话在侧栏按归档过滤灰显可见，两项操作对归档会话同样可用（归档会话不在宿主内存中，天然满足闸门）。

## 弹窗分发

- 行随菜单关闭而卸载，弹窗必须挂在行外：两项操作共用一个请求桥（`src/client/requests.ts`），`shell.overlay` 常驻条目（`src/client/dialogs.tsx`）按 `kind` 分发迁移弹窗 / 预设弹窗，请求按 `kind:sessionId` 换 key 重挂。
- 两弹窗自带弹窗内 Toast 反馈（成功与失败同流，5 秒），弹窗保持打开；无需额外通知通道。
- 通知通道划分通则见仓库根 docs/panel.md；跨语言切换须存活的提示用消息描述子 `{key, params} | {text}`，渲染期取词（见仓库根 docs/i18n.md）。

## 会话列表刷新

- 迁移成功后客户端全量刷新官方会话列表（`sessions.refresh`）；刷新失败提示刷新页面查看新工作区。

## 官方快照事实

- 菜单闸门全部来自官方客户端快照（`useSessions` 全局标准席位），不读聊天内容；subagent 回退行仅存在于 byId。
