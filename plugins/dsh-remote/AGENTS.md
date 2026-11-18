# dsh-remote

设置页「远程开发」插件（`@weilence/dsh-remote`）：经 OpenSSH 在远端机部署并管理一套完整 dsh web 实例（连接内含远端部署），提供环境同步（skills / MCP / 插件 / 系统提示词）与 dsh-sessions 使用的已连接远端传输通道。

## 运行模型

本插件在本机侧只做编排：连接库持久化在 `$DSH_HOME/dsh-remote.json`，运行态（阶段 / 转发子进程 / pid）只驻内存、宿主重启即回 idle；远端实例是 systemd 用户服务（单元固定 `dsh-web.service`），独立于任何本地连接常驻，本地侧的常驻事实只有 `ssh -N -L` 转发进程——因此没有「断开」操作，「删除连接」只清本机侧，转发意外中断由引擎自动重连。连接、心跳自动恢复、手动升级远端、自动重连都复用同一条幂等的 `runConnect` 全流程（部署段 + systemd 启动 + 本地隧道 + 实例版本判定），不要实现旁路的部分流程。

## 强制约定

- 口令只允许出现在三处——勾选「记住」时的 `dsh-remote.json`（0600）、引擎会话口令表、ssh 子进程环境；其余任何出口（`/state`、响应、进度、错误详情、日志）不得出现明文，`RemoteConnection` 只暴露 `secretState`。
- 本机 dsh 版本探测失败直接中止部署，禁止回退安装 npm latest。
- 插件打包只走 `pnpm pack`，禁止自拼 tar——catalog:/workspace: 依赖 spec 靠它落成具体 range。
- 实例端口由本插件选定并写进 systemd 单元，不用 `--port 0`；复用连接禁止重新探测端口。
- 版本双口径不可混用：`/version` 自报与实例判定只用模块加载定格的快照（`localDshVersion` / `localPluginVersion`），部署对齐目标与漂移基准只用现读（`currentDshVersion`）。
- 同步只往远端新增/覆盖，永不删除远端内容。
- systemd 条件不满足（systemctl / loginctl 缺失、用户总线不可达、linger 开不了）显式报错，禁止 nohup 回退。

## 文档索引

- [docs/deploy.md](docs/deploy.md)：部署与版本治理——前置条件、部署段、systemd 单元与端口策略、就绪等待、双口径、升级与 drift、payload 打包传输。
- [docs/connection.md](docs/connection.md)：连接与隧道——认证矩阵与口令通道、状态机与持久化、本地隧道、心跳健康、自动重连、dsh-sessions 传输通道。
- [docs/sync.md](docs/sync.md)：环境同步——四类同步、比对判据、同步面板交互。
- [docs/panel.md](docs/panel.md)：面板交互——连接卡片、通知通道、连接表单与口令补录、国际化插件特有约定。
- [docs/tests.md](docs/tests.md)：测试地图——每个测试文件覆盖什么，单测 / 集成如何运行。
- [README.md](README.md)：面向用户的功能、前置条件与安装。

全仓约定（双 half 架构、多语言、面板原语、测试分层等）见根 AGENTS.md 文档索引所列的根 docs/ 文档。
