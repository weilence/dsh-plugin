# dsh-sessions 磁盘手术域

本文件承载磁盘手术域——迁移到工作区、预设迁移（`src/surgery.ts` / `guards.ts` / `move.ts` / `preset.ts`）——的行为语义、陷阱与取舍。菜单 / 弹窗交互见 [docs/menu.md](menu.md)，测试地图见 [docs/tests.md](tests.md)。

## 通用底座

- 迁移 / 预设迁移直接操作官方 JSONL 工件（保持原文件名与物理编码：纯文本或 zstd），是官方契约外的受控磁盘手术；各操作的拍板理由见对应「取舍」条。
- 存储根默认按官方 home 约定解析为 `$DSH_HOME/sessions`，自定义位置经 `sessionsRoot` 配置显式指定；宿主未来更换存储布局时功能显式失败而不是误改。
- 需要 DSH `0.2.2-rc.5` 的会话、工作区、持久化及 Web 连接服务；zstd 工件的磁盘手术需 Node 22.15+ / 24 的内置 zstd 支持（官方桌面版自带）。
- `src/index.ts`：host half 入口——路由注册与请求守卫（连接认证 / 来源信任校验 / JSON body 限额），`exclusive` 定义全局存储互斥。
- 全部路由经宿主连接认证（拒绝跨站与非信任来源）；迁移 / 预设共用同一全局存储互斥。
- `src/shared.ts`：host 与 client 共用的路由常量与 wire 类型。
- `src/surgery.ts`：全部磁盘操作集中地——路径编码（对齐官方 `encodeSegment` / `projectKey`）、工件定位（与官方 `findLog` 同口径，同 id 多目录拒绝）、目录边界校验、纯文本 / zstd 工件读取与重编码、`writeTempFile`（0o600 + fsync）与 `replaceSessionFile` 三段式替换。
- `src/guards.ts`：写操作闸门——`assertNotLoaded`（活会话拒绝）、活动 waterfall 复查（迁移）、写锁获取 / 释放。host 进程的 `ctx.sessions` 是官方 `SessionStore`，与客户端 `ISessions` 经同名 Context 声明合并相遇，类型面显式取用宿主侧类型，不依赖声明合并顺序。
- 生效边界（host half 变更需重启宿主、client half 刷新页面即生效）见仓库根 docs/architecture.md。
- 陷阱：官方实现在 `C:\Users\weile\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` 内（session-persistence-jsonl / dsh-workspace / dsh-session），是只读参考——改磁盘手术代码前先对照官方实现，不要按猜测实现持久化语义。
- 陷阱：损坏工件（截断帧、不完整尾行）一律拒绝改写，不得猜测修补；zstd 容器契约是「独立帧串联、头行独占第一帧」，重编码必须保持该契约，不能按通用 zstd 流处理。
- 陷阱：目录边界校验（两层 `<root>/<项目目录>/<会话目录>`）必须逐级拒绝符号链接与 junction，是迁移预检的一部分，不能只校验最终目录。

## 迁移到工作区

- 原地磁盘手术（取舍：不走导出-删除-导入——正文逐字节保留，只改日志头 cwd 与工件位置）：日志头工作目录改写为目标路径并把工件发布到目标项目目录；随后从旧工作区账本移除并挂到目标工作区。
- 快路径：会话规范 cwd 已等于目标路径时只补挂工作区账本成员资格（官方 `attachSession`），日志原地不动——是「cwd 正确却停留在未分组」会话的修复入口。
- 日志已有 `working-directory/change` 历史时补记一条事件（seq 连续才允许，否则取消迁移），保证恢复后的工作目录投影正确。
- 发布顺序固定「先隐藏旧工件（非规范文件名对官方后端不可见）再发布新工件」（取舍：崩溃窗口宁可短暂缺失，也不产生同 id 双目录——官方后端会拒绝这种状态）；任何一步失败恢复原文件，回滚失败把恢复文件路径原样交给用户。
- 闸门：目标工作区必须存在；子会话不提供迁移（请迁移主会话）；旧代格式日志先在宿主中打开一次完成格式升级；会话必须未加载且无进行中的活动。
- 工作区注册表头缓存补挂：官方注册表把会话头缓存在私有 Map（启动时建立，命中即不刷新），磁盘手术后 `attachSession` 的 cwd 强校验会读到旧值；插件经 `refreshRegistryHeaderCache` 按特性探测补缓存（headers / sessionPaths / missingSessionPaths / invalidSessionPaths 四者齐备才补），探测不到时返回 `membershipPending`——文件已完成迁移，弹窗提示重启宿主后再次迁移（将走快路径）完成归属。
- 历史文本与工具参数中的旧绝对路径不会被改写；继续会话后须核对实际目标。
- 陷阱：工作区注册表头缓存命中即不刷新——磁盘手术后不补缓存就直接 `attachSession`，其 cwd 强校验会读到旧值而失败；补缓存必须按特性探测，宿主升级后探测不到时走 `membershipPending` 降级，绝不猜测字段形态。
- 陷阱：回滚失败时备份文件保留在原地并在日志与错误信息中给出路径——这是设计行为，不要清理或掩盖备份。
- 取舍：活会话免重启迁移不做——需要重绑宿主内部写入路径，官方契约不暴露，已加载会话一律拒绝。

## 预设迁移

- 只改写最后一条 `agent-preset/selected` 事件（无选择记录时改写日志头 `agentPreset`），消息历史不动；经 `ctx.get('agentPresets')` 校验目标预设存在；宿主未挂载预设服务时功能整体禁用（503）。
- 改写走备份-发布-回滚三段式原子替换；回滚失败保留备份文件并在日志与错误信息中给出路径。
- 取舍：只改最后一条事件、消息历史不动——功能定位于恢复预设被改名或删除后无法恢复的会话，同值幂等。
