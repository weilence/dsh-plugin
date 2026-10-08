# dsh-sessions

- 日志归档直接兼容宿主官方 ZIP 格式，验证、附件和持久化只使用官方服务契约。
- 导入只创建不存在的冷会话；相同内容跳过，冲突或运行中的会话拒绝。写入前完成整份归档校验。
- 归档删除是官方契约外的受控操作（宿主无删除 API）：仅限归档集内会话；删除时刻经官方 `workspace/session-activity` waterfall 复查无活动（与归档同一契约）；官方 `stat` 确认后按官方布局定位目录（核对 v4 生成日志）；写锁尽力互斥——抢到 `open(id, 'write')` 则持锁删除，`SessionAlreadyOwnedError` 无法区分宿主自身句柄与共享存储的另一实例，按宿主空闲句柄继续删除（残余边界见 README），其他错误显式拒绝。存储根由 `sessionsRoot` 配置或官方 home 约定解析；删除后官方 `unarchive` 清理归档条目。
- 会话迁移（侧栏 `sidebar.workspaces.session.menu.item` 条目 + `MIGRATE_PATH`）是官方契约外的受控编排「官方导出 → 归档 → 删除 → 导入」：官方工作区成员资格按会话日志头 cwd 派生（`attachSession` 强校验、头部 cwd 不可改写），契约内没有跨工作区移动，官方移动语义与会话行右键打开菜单属上游缺口（见 README）。会话规范 cwd 已等于目标路径时走快路径：仅 `attachSession` 补账本成员资格即返回（`attached: true`，修复「cwd 正确却停留在未分组」的会话），不进入导出-删除-导入。导出经官方 `session-log-export` 库（`peerDependencies` 声明）；编排先查 `ctx.sessions.get` 拒绝已加载会话，再过活动 waterfall；日志删除后导入失败的失败结果携带导出 ZIP（Base64）与目标目录，客户端提供下载恢复入口。
- host 与 client 共用的路由常量和 wire 类型集中于 `src/shared.ts`。
- 面板提示与恢复 / 删除编排在 `src/client/store.ts`：store 持有 notice（官方 Toast 展示）、行锚定 failure、删除确认目标与恢复/删除互斥，组件经 `useSyncExternalStore` 只读订阅；面板卸载即清空一次性反馈，不在下次打开时重放。
- 宿主不发布会话移除事件，归档条目清除后侧栏会解除隐藏过期摘要：删除成功后客户端必须全量刷新官方会话列表（`sessions.refresh`）。
- `D:\Code\deepseek-harness` 是只读参考源码；插件测试覆盖安全限制、并发冲突和部分导入结果。
