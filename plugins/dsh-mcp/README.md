# dsh-mcp

DSH 设置页「MCP 管理」插件：以官方 [mcp-client](https://github.com/deepseek-ai/deepseek-harness/tree/develop/packages/mcp/mcp-client) 组合行为唯一事实源，浏览 / 增删改当前 profile 的 MCP 服务器，并实时展示每个服务器的连接状态与已注册工具。

## 为什么这么做

DSH 里一个 MCP 服务器就是 cordis patch 里的一个 `@deepseek-ai/dsh-mcp-client` 插件行（stdio 子进程或 streamable-http 端点），没有独立的"服务器注册表"。本插件不做第二套配置存储，直接读写官方的两层用户 patch：

| 层         | 文件                                          | 生效范围                                  |
| ---------- | --------------------------------------------- | ----------------------------------------- |
| Profile 层 | `<DSH_HOME>/profiles/<name>/cordis.patch.yml` | 仅当前 profile                            |
| 全局层     | `<DSH_HOME>/cordis.patch.yml`                 | 所有 profile（应用顺序在 profile 层之后） |

bundle 声明或 `--patch` 命令行覆盖引入的服务器行只读展示（标注来源）。

## 功能

- **目录**：列出两层声明 + 只读来源的 MCP 服务器，含传输形态、端点、组合后的生效配置（裸覆盖行按官方语义 fold：后行覆盖前行、home 层后于 profile 层）。
- **运行态**：每个服务器显示 fiber 状态（连接中 / 运行中 · N 工具 / 失败含错误摘要 / 已停用 / 待生效）与 `mcp__<serverName>__*` 工具清单，数据来自宿主 Loader 条目树与工具注册表。
- **新建 / 编辑**：表单覆盖两种传输形态的常用键（`command`/`args`/`env`/`cwd` 与 `url`/`headers`，及 `toolCallTimeoutMs`、`failOnStartupError`）；高级键（`reconnect`、`maxInstructionBytes`）不在表单内但编辑时**原样保留**，可直接手改 patch 文件。
- **启停 / 删除**：停用写入官方 plugin-manager 同形态的 `{ id, disabled: true }` 裸行；删除移除 insert 声明与所有指向它的裸覆盖行。
- **注释保留**：所有写入都是 YAML Document 级往返（与官方 plugin-manager 的 patch 编辑同一实现路数），文件里的手写注释与无关行不动。

## 生效时机（重要）

保存 / 启停 / 删除只是**写 patch 文件**；生效靠 HMR 的 patch watcher：

- 宿主启用 HMR 时（desktop/web 开发组合默认带 `hmr` 行），两层 patch 文件被精确路径监视，写入后即刻 `reconcileProfilePatches` 在线重整——新服务器的工具马上注册进全局工具表，**运行中的会话下一个回复即可调用**；停用 / 删除同理即时卸载。面板顶部的提示会标明当前宿主是否处于此模式。
- 面板在写操作后会自动再刷新两次（约 1.2s / 4s），兜住 watcher → Loader 重挂载的异步窗口。
- 宿主未启用 HMR 时，写入只落盘，重启应用后生效（「刷新」按钮可随时重读文件与运行态）。

## serverName 约定

- 匹配 `^[A-Za-z0-9_-]{1,32}$`（官方约束），决定模型看到的工具名前缀 `mcp__<serverName>__<tool>`；
- 全局唯一：运行时按它预留命名空间，撞名的后加载行会失败，保存前有前置校验（409）；
- 创建后 patch 行 id 固定为 `mcp-<serverName>`；编辑时改 serverName 只改工具前缀，行 id 不变（改 id 等价于删除重建）。

## 连接兼容性备注（stdio 服务器实现方）

当前 DSH 捆绑的 MCP SDK（client 2.x）握手首步是新版 `server/discover` 探测（协议 2026-07-28）：

- 正常服务器（官方 SDK 各版本实现）都会应答 discover，或按 JSON-RPC 规范对未知方法回 `-32601` 错误——客户端随即回落经典 `initialize` 握手，两者都能完成连接；
- **静默吞掉未知方法的极简 / 自制服务器会让连接永远停在「连接中」**（客户端对该探测无超时）。自制服务器务必对每个带 id 的请求都有响应（哪怕是错误对象）。

## 安全

与 [dsh-skills](../dsh-skills) 同一套同源桥约束：回环 Host 校验（拒绝 DNS-rebinding）、`sec-fetch-site` 跨站拒绝（简单 POST 折在 CORS 预检）、2 MiB 请求体上限。写操作仅作用于上述两层用户 patch 文件，原子替换落盘（同目录临时文件 + rename，`0o600`）。

## 安装

```bash
# 在 profile 目录（~/.dsh/profiles/desktop）
pnpm add link:D:/Code/dsh-plugins/plugins/dsh-mcp
```

然后把 `dsh-mcp` 加入 `package.json` 的 `dsh.profile.bundles`（link: 安装时 boot 会合并本包自带的 `cordis.patch.yml` 插入行）。刷新设置页即可看到「MCP 管理」菜单。

host half 变更需要重启应用（Node ESM 缓存）；client half 刷新页面即生效。

## 开发

```bash
pnpm --filter dsh-mcp build      # tsdown 双产物（host ESM 内联 yaml / client CJS）
pnpm --filter dsh-mcp typecheck
pnpm --filter dsh-mcp test       # patchFile / mcpConfig / host 桥集成
```

结构：

```
src/index.ts       host half：四个 HTTP 桥路由（list / save / set-enabled / delete）
src/patchFile.ts   cordis.patch.yml 注释保留编辑（insert / 裸覆盖 / 删除 / 启停）
src/mcpConfig.ts   配置校验与编辑合并（官方 mcp-client Config schema 对齐）
src/live.ts        Loader / 工具注册表运行态内省（结构化最小接口，防御式读取）
src/shared.ts      线协议与常量
src/client/        settings.section 面板 + 新建 / 编辑 / 查看弹窗
```
