# @weilence/dsh-notify

回合完成 / 提问 / 审批等待时弹系统桌面通知的插件；host half 提供 desktop 窗口恢复接口。

## 实现约束

- 提问 / 审批监听必须走 `sessionStatus` 汇聚点，直接 `$on` waterfall 事件收不到（缘由见 [docs/behavior.md](docs/behavior.md)）。
- spawn `dsh://open` 前必须从子进程环境清掉 `ELECTRON_RUN_AS_NODE`，否则 Electron 以纯 Node 模式启动、不解析协议参数（详见 [docs/behavior.md](docs/behavior.md)）。

## 文档

- [docs/behavior.md](docs/behavior.md)：行为与陷阱——定位、结构导览、事件订阅与通知投递语义、host 路由。
- [docs/tests.md](docs/tests.md)：测试地图——每个测试文件覆盖什么、如何运行。
- [README.md](README.md)：面向用户的功能、安装与使用说明。
