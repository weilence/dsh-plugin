# @weilence/dsh-prompts

设置页「全局提示词」插件：管理 DeepSeek Harness 用户级 `AGENTS.md`，不修改工作区指令或系统提示词。

- host half 提供同源读取、保存与删除路由，目标为 `resolveDshHome(config.dshHome)/AGENTS.md`；浏览器不能提交目标路径。若 `dsh-agent-instructions` 单独配置了 `dshHome`，部署者需在本插件显式配置同值；宿主没有公开另一插件已解析配置的接口。
- 不存在与空文件有不同的语义，删除须再次确认。
- client half 在设置页提供原文编辑、刷新、创建和删除；读取失败时禁止覆盖写入，明确显示实际错误。
- 路由测试（host.test.ts）覆盖防跨站、并发冲突与文件读写。
