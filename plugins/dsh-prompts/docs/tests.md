# dsh-prompts 测试地图

本文件承载 dsh-prompts 的测试地图：每个测试文件覆盖什么、如何运行。分层与运行约定见根 docs/testing.md。

- `test/host.test.ts` 是本插件唯一测试文件：假 `ctx` / `webServer` + fake req/res 桩走完整请求-响应链路（范式见根 docs/testing.md），分「系统提示词路由」「系统提示词段」两组。
- 路由组覆盖防跨站、并发冲突与文件读写：读取不存在文件与新建 / 编辑往返；显式 `config.dshHome` 优先于环境变量；旧版本覆盖外部更新与重复创建返回冲突；拒绝符号链接及读取失败时的误覆盖；拒绝跨站请求、无自定义头的写请求和畸形请求体。
- 段组覆盖注册参数、随文件即时同步与异常兜底：注册参数（固定名称 `user:system-prompt`、位于第一方末尾之后、不做变量插值）；段文本随文件即时同步、文件缺失时为空串；符号链接与超过 1 MiB 的文件不进入系统提示词。
- 运行：`pnpm --filter @weilence/dsh-prompts test`。本包无集成测试，`test/` 保持扁平单层；提交前与发版前的整体验证按根 docs/testing.md 与根 AGENTS.md「强制约定」执行。
