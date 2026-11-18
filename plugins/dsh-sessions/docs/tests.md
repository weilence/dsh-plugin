# dsh-sessions 测试地图

本文件承载测试覆盖地图：每个测试文件覆盖什么、如何运行。运行与分层规则见仓库根 docs/testing.md。

- 运行：单测 `pnpm --filter @weilence/dsh-sessions test`；本插件无集成测试（不 spawn 真外部进程 / 真 socket，`test/` 保持扁平，无 `test:integration` script）。
- `test/surgery.test.ts`：路径编码与文件名解析、工件定位与目录边界、工件读取与重编码（zstd 帧扫描 / 容器契约）、`replaceSessionFile` 三段式（含回滚保留）。
- `test/operations.test.ts`：预设迁移（事件 / 日志头改写与闸门）与批量编排（去重 / 上限 / 互斥串行 / 级联覆盖集）。
- `test/import.test.ts`：多份 ZIP 导入（逐份校验、单份失败继续、同 ID 跳过 / 分叉拒绝）。
- `test/archive.test.ts`：官方会话归档解析与整份校验（ZIP 条目、附件、CRC / SHA-256 / 谱系 / 格式语义）。
- `test/host.test.ts`：宿主路由——路由注册与导入路由、删除 / 迁移 / 预设路由；假 `ctx` / `webServer` + fake req/res 桩走完整请求-响应链路（范本见仓库根 docs/testing.md）。
- `test/client.test.tsx`：会话面板列表（过滤矩阵）、行操作编排、迁移与预设弹窗、批量操作 UI、词条。
- `test/i18n.ts`：非测试文件——`makeT` 取词辅助（与宿主同一插值语义，见仓库根 docs/i18n.md）。
- 整体覆盖面向：目录边界、损坏拒绝、回滚保留、谱系级联、缓存降级、闸门拒绝与面板过滤矩阵。
