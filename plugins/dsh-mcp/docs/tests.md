# dsh-mcp 测试地图

本文件承载测试地图：每个测试文件覆盖什么、如何运行；单测 / 集成的划分标准与手动执行约定见根 `docs/testing.md`。

- 运行：单测 `pnpm --filter @weilence/dsh-mcp test`（默认只跑单测，四项检查随之只覆盖单测）；集成测试手动 `pnpm --filter @weilence/dsh-mcp test:integration`（全仓 `pnpm -r test:integration`，重要改动与发版前应跑一遍）。
- `test/unit/mcpFile.test.ts` / `test/unit/mcpApply.test.ts` / `test/unit/mcpConfig.test.ts` / `test/unit/mcpImport.test.ts`：纯函数单测——分别覆盖 `.mcp.json` 方言解析与 round-trip、挂载 diff、配置校验、标准 MCP JSON 导入导出。
- `test/unit/store.test.ts`：fake timers + mock list 应答，验证过渡态轮询的起停与写请求 revision / cwd 附带。
- `test/unit/host.test.ts`：假 ctx + 假 loader（记录 create / update / remove，store 与真 Loader 同为 Dict 形态）+ 两份临时文件，做六路由的完整请求-响应测试（host 路由测试范本见根 `docs/testing.md`，拆分过的包在 `test/unit/` 下）。
- `test/integration/probe.test.ts`：探测集成测试——真 node 子进程 + 真本地 SSE 服务器，含真超时语义。
- `test/i18n.ts`：`makeT` 取词桩（与宿主同一种插值语义，common 词条按需快照），供单测使用。
