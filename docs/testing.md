# 测试约定

本文件承载测试分层与运行方式；提交前的四项检查见根 AGENTS.md「强制约定」。

- 每包独立 vitest，无全局配置：`pnpm --filter <pkg> test`。
- 单测与集成测试按「是否 spawn 真外部进程 / 走真 socket」划分：纯函数与假桩（含 tmp 目录文件 IO）属单测；spawn 真 git / 真 node 子进程 / 真本地服务器的属集成测试，mock 替身会把这些测试退化成「测我们对外部工具的假设」（`-z` 重命名字段序、bash 缺分号等事实都是实证来的）。有集成测试的包 `test/` 拆 `test/unit/` 与 `test/integration/` 两层（现：dsh-git 的 log、dsh-skills 的 gitInstall / gitUpdate、dsh-mcp 的 probe、dsh-remote 的 pack）；无集成测试的包保持扁平 `test/`。默认 `pnpm --filter <pkg> test` 只跑单测（拆分包的 `test` script 即 `vitest run test/unit`，四项检查随之只覆盖单测）；集成测试**手动**执行：`pnpm -r test:integration`（单包 `pnpm --filter <pkg> test:integration`），重要改动与发版前应跑一遍。
- host 路由测试用假 `ctx` / `webServer` + fake req/res 桩走完整的请求-响应链路（范本：各插件 `test/host.test.ts`，拆分过的包在 `test/unit/` 下）；`@dsh-plugins/shared/http` 的请求校验纯函数在 shared 包直接单测。
- 官方契约类型一律 type-only 导入（`import type {} from '@deepseek-ai/…'` 声明合并进 `Context`），编译产物保持零运行时导入。
