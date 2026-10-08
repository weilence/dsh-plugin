# dsh-sessions

- 日志归档直接兼容宿主官方 ZIP 格式，验证、附件和持久化只使用官方服务契约。
- 导入只创建不存在的冷会话；相同内容跳过，冲突或运行中的会话拒绝。写入前完成整份归档校验。
- 归档删除是官方契约外的受控操作（宿主无删除 API）：仅限归档集内会话；删除时刻经官方 `workspace/session-activity` waterfall 复查无活动（与归档同一契约）；官方 `stat` 确认后按官方布局定位目录（核对 v4 生成日志）；写锁尽力互斥——抢到 `open(id, 'write')` 则持锁删除，`SessionAlreadyOwnedError` 无法区分宿主自身句柄与共享存储的另一实例，按宿主空闲句柄继续删除（残余边界见 README），其他错误显式拒绝。存储根由 `sessionsRoot` 配置或官方 home 约定解析；删除后官方 `unarchive` 清理归档条目。
- host 与 client 共用的路由常量和 wire 类型集中于 `src/shared.ts`。
- 宿主不发布会话移除事件，归档条目清除后侧栏会解除隐藏过期摘要：删除成功后客户端必须全量刷新官方会话列表（`sessions.refresh`）。
- `D:\Code\deepseek-harness` 是只读参考源码；插件测试覆盖安全限制、并发冲突和部分导入结果。
