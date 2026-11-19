# dsh-sessions 测试地图

本文件承载测试覆盖地图：每个测试文件覆盖什么、如何运行。运行与分层规则见仓库根 docs/testing.md。

- 运行：单测 `pnpm --filter @weilence/dsh-sessions test`；本插件无集成测试（不 spawn 真外部进程 / 真 socket，`test/` 保持扁平，无 `test:integration` script）。
- `test/surgery.test.ts`：路径编码与文件名解析、工件定位与目录边界、工件读取与重编码（zstd 帧扫描 / 容器契约）、`replaceSessionFile` 三段式（含回滚保留）。
- `test/operations.test.ts`：原地迁移（快路径 / 原地改写 / 缓存补挂降级）与预设迁移（事件 / 日志头改写与闸门），zstd 与纯文本双矩阵。
- `test/host.test.ts`：宿主路由——路由注册、认证与协议守卫、参数校验、迁移 / 预设结果透传、全局存储互斥；假 `ctx` / `webServer` + fake req/res 桩走完整请求-响应链路（范本见仓库根 docs/testing.md）。
- `test/client.test.tsx`：会话行菜单条目（子会话禁用矩阵、已加载禁用矩阵）、弹窗宿主分发（迁移 / 预设）、迁移与预设弹窗流程（成功关闭弹窗 + 常驻条目横幅、失败行内常驻）、加载探针三分支（已加载禁用 / 探测中禁用 / 失败放行）、词条键集一致。
- `test/i18n.ts`：非测试文件——`makeT` 取词辅助（与宿主同一插值语义，见仓库根 docs/i18n.md）。
- 整体覆盖面向：目录边界、损坏拒绝、回滚保留、缓存降级、闸门拒绝与菜单禁用矩阵。
