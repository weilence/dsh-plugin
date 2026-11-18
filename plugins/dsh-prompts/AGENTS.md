# @weilence/dsh-prompts

设置页「系统提示词」插件：管理用户系统提示词正文 `$DSH_HOME/system-prompt.md`，并把它注册进宿主系统提示词组装；不碰 `AGENTS.md` 指令链（那是 `dsh-agent-instructions` 的职责），也不修改工作区指令。

## 实现约束

- `interpolate: false` 不可改——用户文本里的未知变量引用会让系统提示词组装失败。
- 段文本求值抛错会拖垮宿主全部请求——任何读取异常必须空串兜底（并按错误去重警告一次）。
- 浏览器不能提交目标路径——面板读写目标只由服务端 `resolveDshHome(config.dshHome)` 解析。

## 文档

- [README.md](README.md)：面向用户的功能与安装文档（内部规格不写进 README）。
- [docs/behavior.md](docs/behavior.md)：行为与陷阱——插件定位、结构导览、提示词段与面板读写。
- [docs/tests.md](docs/tests.md)：测试地图——测试覆盖与运行方式。
