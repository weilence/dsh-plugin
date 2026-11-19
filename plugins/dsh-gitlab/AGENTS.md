# @weilence/dsh-gitlab

设置页「GitLab」插件。定位是替代 GitLab MCP 的全量工具注入：host half spawn glab CLI（认证外包给用户自己的 glab 登录态，插件只注入 GITLAB_HOST 选站），注册一个 `glab` 透传模型工具；client half 提供站点设置面板（含 glab 环境探测与认证测试）。全仓约定（双 half、多语言、面板原语、测试分层）见根 AGENTS.md 文档索引。

## 实现约束

- 单工具架构是定稿需求：新增能力优先扩展工具描述里的速查或依赖 glab 子命令，不拆语义工具；确需第二个工具时先回到方案层（理由见 [docs/decisions.md](docs/decisions.md)）。
- `runGlab` 是唯一的 spawn 出口：新调用路径（面板探测、连接测试等）必须走它，超时 / 取消 / 有界捕获不得绕过。
- 超时与取消语义分离：`timeoutSec` 到点返回已捕获产物（`timedOut: true`），调用方 `exec.signal` 取消必须原样抛 `signal.reason`——包成普通 Error 会破坏宿主管道的 ABORTED 语义。
- 测试注入 seam 只有两个：`ApplyOptions.runGlab`（spawn 替身）与 `ApplyOptions.glab`（二进制探测结果）；不要为测试增加环境分支。

## 生效链路

- 站点写路由 → `configEditor.edit` → Loader 走普通更新路径 → 本插件 fiber 重挂 → 工具 / 路由 / 快照整体重建；工具 `when` 同步读快照（glab 不可用或无站点时工具整体不进模型面）。
- 工具与测试探测每次执行现读站点配置；glab 二进制状态在 refresh 时重建——装好 glab 后点面板「刷新」即恢复可用。
- 认证完全外包：执行时 env 只注入 `GITLAB_HOST`（来自站点 url），`GITLAB_TOKEN` 等凭据变量是用户自己的环境，插件不碰；glab 未认证时工具原样返回其报错，面板「测试连接」用于前置排查。

## 文档索引

- [docs/spec.md](docs/spec.md)：行为规格——结构导览（每文件一行）、站点模型与选站顺序、工具 / 路由 / 面板语义、生效链路。
- [docs/traps.md](docs/traps.md)：实证事实与易错点（spawn 流语义、有界捕获边界、GUI 进程 PATH、glab 包装劫持等）。
- [docs/decisions.md](docs/decisions.md)：已确认决策与取舍理由（单工具架构、认证外包、选站顺序、超时语义），改动需回到方案层。
- [docs/tests.md](docs/tests.md)：测试地图——单测 / 集成覆盖与运行方式。
- [README.md](README.md)：面向用户的功能介绍与安装说明。
