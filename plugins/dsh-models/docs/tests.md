# docs/tests.md——测试地图

本文件承载 dsh-models 的测试地图：每块测试覆盖什么、如何运行。单测 / 集成的划分规则见[根 docs/testing.md](../../../docs/testing.md)「测试约定」节。

## 运行

- 单测：`pnpm --filter @weilence/dsh-models test`；本包 `test/` 为扁平单测层，未拆 `test/unit` / `test/integration`。
- 集成测试：本包无集成测试层；全仓集成测试手动执行 `pnpm -r test:integration`（重要改动与发版前应跑一遍）。

## 覆盖（块 → 测试文件）

- mirror（退避 / ETag / 持久化）：`test/mirror.test.ts`。
- catalog 与 pi-ai 纯函数：`test/catalog.test.ts`、`test/matching.test.ts`、`test/profile.test.ts`、`test/profile-plan.test.ts`。
- Host 路由测试（假 `ctx` / `webServer` + fake req/res 桩走完整请求-响应链路，范本见[根 docs/testing.md](../../../docs/testing.md)「测试约定」节）：`test/host.test.ts`、`test/effective.test.ts`、`test/auth.test.ts`、`test/usage-host.test.ts`。
- client：store（含登录轮询生命周期）`test/store.test.ts`、operations `test/operations.test.ts`、panel `test/panel.test.ts`、view `test/view.test.ts`、SignInCard `test/sign-in-card.test.tsx`、表单行内编辑 `test/model-form.test.ts`、`test/route-editor-inline.test.tsx`、`test/create-provider-inline.test.tsx`。
- 用量：各 Provider 用量适配器 `test/usage-zhipu.test.ts`、`test/usage-codex.test.ts`、`test/usage-copilot.test.ts`；展示语义 `test/usage-view.test.tsx`。
- 单测取词：`test/i18n.ts` 的 `makeT`（含 common 词条快照）——机制见[根 docs/i18n.md](../../../docs/i18n.md)「多语言约定」节。
