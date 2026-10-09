# @weilence/dsh-prompts

DeepSeek Harness Web 插件：在设置页新增「系统提示词」，编辑追加到每个模型请求系统提示词末尾的用户段。正文保存在 `$DSH_HOME/system-prompt.md`（设置 `DSH_HOME` 时使用该目录），独立于 `AGENTS.md` 指令链，由本插件直接注册进宿主的系统提示词组装。

## 功能

- 插件启动时通过 `ctx.systemPrompt.section` 注册 `user:system-prompt` 段：位于第一方内容（部署 persona 后缀 10200）之后、顺序 10500，`interpolate: false` 原样保留正文中的 `{{…}}`。
- 段文本在每次组装时重新读取文件：面板保存、外部编辑都在下一个尚未开始的模型步骤生效；文件缺失或为空时段消失，不占任何 token。
- 查看文件路径及 Markdown 原文；尚不存在时直接创建，删除前再次确认。
- 保存前对照读取时的 SHA-256 版本；其他程序已修改文件时返回冲突，不自动覆盖。读取失败时停止编辑，展示真实错误。
- 读取异常（权限、非普通文件、超过 1 MiB）以空串兜底并记录一次警告，绝不阻塞系统提示词组装。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-prompts
```

安装后重启宿主，并在 Web UI 的设置 →「系统提示词」中使用。宿主同时需要将该包加入 `dependencies` 和 profile 的 `dsh.profile.bundles`；上面的命令会完成配置。

**自定义目录**：默认目标为 `$DSH_HOME/system-prompt.md`（未设置时为 `~/.dsh/system-prompt.md`）；在 `dsh-prompts` 组合行设置 `config.dshHome` 可改存其他目录，与 `dsh-agent-instructions` 的配置互不相关。

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
