# dsh-notify 测试地图

本文件承载 @weilence/dsh-notify 的测试地图：每个测试文件覆盖什么、如何运行。

- 运行：`pnpm --filter @weilence/dsh-notify test`。
- `test/notify-client.test.ts`：事件 diff 与文案组装。
- `test/notify-events.test.ts`：事件路径集成，locale 服务用 register/bind 替身。
