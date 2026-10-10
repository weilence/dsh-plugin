# @weilence/dsh-prompts

设置页「系统提示词」插件：管理用户系统提示词正文 `$DSH_HOME/system-prompt.md`，并把它注册进宿主系统提示词组装；不碰 `AGENTS.md` 指令链（那是 `dsh-agent-instructions` 的职责），也不修改工作区指令。

- host half 经 `ctx.systemPrompt.section` 注册 `user:system-prompt` 段：`order: 10500`（部署 persona 后缀 10200 之后，用户段变化只影响提示词尾部，前缀 KV 缓存尽量保留），`interpolate: false`（用户文本里的 `{{…}}` 原样保留，未知变量引用会让组装失败）。
- 段文本每次组装同步重读文件（`lstatSync` + `readFileSync`，无缓存）：外部编辑与面板保存下一步即生效。任何读取异常以空串兜底并按错误去重警告一次——段文本抛错会拖垮宿主全部请求；文件缺失/空内容时段自然消失。
- 面板读写路由目标为 `resolveDshHome(config.dshHome)/system-prompt.md`；浏览器不能提交目标路径。`config.dshHome` 只决定本插件文件所在目录，与 `dsh-agent-instructions` 的 `dshHome` 无关联。
- client half 在设置页提供原文编辑、创建和保存，不设刷新与删除入口：分区每次挂载即重新读取（读取失败时禁止覆盖写入并显示实际错误，重开设置页即重试）；文件不再需要时清空保存即可，缺失与空内容对段文本同义。
- 路由测试（host.test.ts）覆盖防跨站、并发冲突与文件读写；段测试覆盖注册参数、随文件即时同步与异常兜底。
