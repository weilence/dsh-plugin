# @weilence/dsh-prompts

DeepSeek Harness Web 插件：在设置页新增「全局提示词」，编辑用户级 `AGENTS.md`。默认目标为 `~/.dsh/AGENTS.md`，设置 `DSH_HOME` 时使用该目录下的 `AGENTS.md`。

## 功能

- 查看全局文件路径及 Markdown 原文；尚不存在时直接创建。
- 编辑并保存原文，不转换格式；删除前确认，保留刷新入口。
- 保存或删除前对照读取时的 SHA-256 版本；其他程序已修改文件时返回冲突，不自动覆盖。读取失败时停止编辑，展示真实错误。
- 仅管理用户级 `AGENTS.md`，不改动各项目的 `AGENTS.md` / `CLAUDE.md`、会话内容或宿主内置系统提示词。

保存后，Harness 会在当前会话下一次尚未开始的模型步骤重新读取全局指令；不会修改已生成内容，也不会主动推送更新。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-prompts
```

安装后重启宿主，并在 Web UI 的设置 →「全局提示词」中使用。宿主同时需要将该包加入 `dependencies` 和 profile 的 `dsh.profile.bundles`；上面的命令会完成配置。

**自定义指令目录**：若 `dsh-agent-instructions` 的组合行单独设置了 `dshHome`，它会优先于 `DSH_HOME`，而宿主没有公开接口供其他插件读取这一覆盖值。此时必须在 `dsh-prompts` 的组合行也设置**相同的** `config.dshHome`，并在面板核对显示的文件路径；否则面板默认编辑 `$DSH_HOME/AGENTS.md`（未设置时为 `~/.dsh/AGENTS.md`），可能不是智能体实际读取的文件。

插件路由只接受预期 Host 的同源请求，写请求必须携带插件专用请求头；不接受浏览器指定的任意文件路径。单文件上限为 1 MiB，符号链接和非普通文件不能编辑。

## 开发

```bash
pnpm --filter @weilence/dsh-prompts typecheck
pnpm --filter @weilence/dsh-prompts test
pnpm --filter @weilence/dsh-prompts build
```

实现边界与注意事项见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
