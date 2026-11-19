# 两层用户 patch 约定

本文件承载写用户层配置插件共用的 patch 机制；强制约定（round-trip、`config` 整体替换）见根 AGENTS.md「强制约定」。

写用户层配置的插件分两条路径：dsh-mcp（与在远端做同类合并的 dsh-remote）直接编辑两层用户 patch；dsh-zhipu-tools 经宿主 `ctx.configEditor` 写入（文件锁、schema 校验、原子写等由官方保障，见插件内 AGENTS.md）。

直接编辑 patch 的插件共用这一机制：

- 写入目标是两层用户 patch：profile 层 `<profile>/cordis.patch.yml` 与 home 层 `$DSH_HOME/cordis.patch.yml`，按官方语义 fold（后层覆盖前层；bundle / `--patch` 引入的行只读）。
- 生效链路：写盘 → HMR patch watcher 在线重整，宿主未启用 HMR 时需重启；写操作后面板补偿刷新两次（约 1.2s / 4s），覆盖 watcher → 重挂载的窗口期。
