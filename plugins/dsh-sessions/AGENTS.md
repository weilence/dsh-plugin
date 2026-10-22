# dsh-sessions

- 面向「删除 / 迁移 / 预设迁移」的全部磁盘操作集中在 `src/surgery.ts`：路径编码对齐官方 `encodeSegment`/`projectKey`，工件定位与官方 `findLog` 同口径（含同 id 多目录拒绝），zstd 工件按「独立帧串联、头行独占第一帧」的容器契约读取与重编码；截断帧或不完整尾行一律拒绝改写。文件替换走 `writeTempFile`（0o600 + fsync）+ 备份-发布-回滚三段式，回滚失败保留备份并上报路径。
- 删除（`src/delete.ts`）是官方契约外的受控操作：官方持久化头现扫后代谱系，主会话与全部后代先全量预检（未加载 / 活动 waterfall / 目录边界）再后代逆序删除；写锁尽力互斥——`SessionAlreadyOwnedError` 按宿主空闲句既有边界继续，其余错误显式拒绝。账本清理失败只警告不回滚文件删除。
- 迁移（`src/move.ts`）是原地磁盘手术，不再走导出-删除-导入：改写日志头 cwd 并发布到目标项目目录，正文逐字节保留；日志已有 `working-directory/change` 历史时补记一条事件（seq 连续才允许，否则取消迁移）。cwd 已等于目标路径时走快路径仅 `attachSession` 补账。发布顺序是「先隐藏旧工件（非规范文件名对官方后端不可见）再发布新工件」，崩溃窗口宁可短暂缺失也不产生同 id 双目录。
- 工作区注册表把会话头缓存在私有 Map（启动时建立，命中即不刷新）；磁盘手术后 `refreshRegistryHeaderCache` 按特性探测补缓存（headers / sessionPaths / missingSessionPaths / invalidSessionPaths 四者齐备才补），探测不到时返回 `membershipPending` 引导重启后走快路径，绝不猜测。这是契约外受控操作，宿主字段更名时自动降级。
- 预设迁移（`src/preset.ts`）只改写最后一条 `agent-preset/selected` 事件（无则改日志头 `agentPreset`），消息历史不动；经 `ctx.get('agentPresets')` 校验目标预设存在，服务未挂载时功能整体禁用（503）。
- 活会话一律拒绝（`guards.ts` 的 `assertNotLoaded`）：免重启迁移需要重绑宿主内部写入路径，契约不暴露；绕过活内存态删除会让宿主追加路径重建部分日志。
- 面板数据全部来自官方客户端快照（`ISessions.list` + `IWorkspaces.list`），搜索 / 过滤 / 排序纯客户端实现，不读聊天内容；subagent 回退行仅存在于 byId，列表构建时并入。列表用 `@dsh-plugins/client-ui` 的 `CardList`/`ExpandableCard`（与 dsh-skills 同款可展开卡片；批量模式经共享卡片 `selection` 的行首选择列——整列纵向热区点击即勾选，行头其余区域仍是展开——并隐藏行内动作）。行操作编排在 `src/client/store.ts`，迁移弹窗经 `src/client/migrate.tsx` 的桥同时服务侧栏菜单与面板行内入口。
- 批量操作（`src/batch.ts` host 编排 + `src/client/batch.tsx` UI）：删除 / 迁移 / 预设走 `/batch` 单路由——请求去重与 ≤200 上限前置校验，整批持存储互斥逐项串行，单项闸门失败只记为该项失败并继续；删除维护级联已覆盖集，父子同批时后到者标记 `cascaded`。归档 / 恢复不走 host：客户端循环官方命令（宿主控制器已串行化）。批量模式的选择集跨过滤保留、退出即清空；「选中本筛选结果」只取当前可见行；删除先经预览弹窗（列目标 + 运行中标注），逐项明细进结果弹窗，「重试失败」对失败 id 原参数重跑；操作级反馈仍走 notice 一句话汇总。
- 所有提示信息（成功与失败、面板与弹窗）一律优先 notice：官方 `Toast` 横幅（5 秒、文本作 key 重开计时、下次操作即替换），不放行内常驻；导入弹窗的逐文件结果清单是报告不是提示，保持列表呈现。
- 面板根经 `useWideSettingsDialog()`（`@dsh-plugins/client-ui`）加宽宿主设置弹窗（与 dsh-skills 同款 1200×920 上限），切到其他分区即还原。
- ZIP 导入机制不变：只创建不存在的冷会话，写入前整份校验；导入仍占用全局存储互斥，删除 / 迁移 / 预设 / 批量路由共用同一互斥（`src/index.ts` 的 `exclusive`）。
- host 与 client 共用的路由常量和 wire 类型集中于 `src/shared.ts`。
- 宿主不发布会话移除事件，账本清理后侧栏会解除隐藏过期摘要：删除成功后客户端必须全量刷新官方会话列表（`sessions.refresh`）。
- `C:\Users\weile\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` 内的官方实现（session-persistence-jsonl / dsh-workspace / dsh-session）是只读参考；本插件测试覆盖目录边界、损坏拒绝、回滚保留、谱系级联、缓存降级、闸门拒绝与面板过滤矩阵。
