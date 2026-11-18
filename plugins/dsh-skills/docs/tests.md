# 测试地图（@weilence/dsh-skills）

本文件承载各测试文件的覆盖范围与运行方式；单测 / 集成两层划分与运行约定见[根 docs/testing.md](../../../docs/testing.md)「测试约定」节。

- 默认单测：`pnpm --filter @weilence/dsh-skills test`（即 `vitest run test/unit`，四项检查只覆盖单测）。
- 集成测试手动执行：`pnpm --filter @weilence/dsh-skills test:integration`（全局 `pnpm -r test:integration`），重要改动与发版前应跑一遍。
- `test/unit/scan.test.ts`、`frontmatter.test.ts`、`roots.test.ts`、`store.test.ts`：scan / frontmatter / roots / store 纯函数与临时目录单测。
- `test/unit/host.test.ts`：host half 八个路由的请求-响应测试（假 `ctx` / `webServer` + fake req/res 桩，范本约定见[根 docs/testing.md](../../../docs/testing.md)「测试约定」节）。
- 涉及文案断言的单测经 `test/i18n.ts` 的 `makeT` 取词（含 common 词条快照）。
- `test/integration/gitInstall.test.ts` / `test/integration/gitUpdate.test.ts`：gitInstall / gitUpdate 真 git 全链路（partial clone / sparse checkout / 更新跟踪）。
