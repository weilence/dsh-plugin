# @weilence/dsh-mcp

DSH web 插件：在设置页新增「MCP 管理」菜单，以官方 [mcp-client](https://github.com/deepseek-ai/deepseek-harness/tree/develop/packages/mcp/mcp-client) 的组合行为为唯一事实源，浏览 / 增删改当前 profile 的 MCP 服务器，并实时展示每个服务器的连接状态与已注册工具。

## 功能

- **目录**：列出两层声明（profile / 全局）+ 只读来源（bundle、`--patch` 覆盖）的 MCP 服务器，含传输形态、端点、组合后的生效配置。
- **运行态**：每个服务器显示 fiber 状态（连接中 / 运行中 · N 工具 / 失败含错误摘要 / 已停用 / 待生效）与 `mcp__<serverName>__*` 工具清单。
- **新建 / 编辑**：表单覆盖两种传输形态的常用键（stdio 的 `command`/`args`/`env`/`cwd` 与 streamable-http 的 `url`/`headers`，及 `toolCallTimeoutMs`、`failOnStartupError`），也支持 JSON 直接粘贴；高级键（`reconnect`、`maxInstructionBytes`）编辑时原样保留。
- **启停 / 删除**：停用写入官方 plugin-manager 同形态的 `{ id, disabled: true }` 覆盖行；删除移除 insert 声明与所有指向它的覆盖行。
- **注释保留**：所有写入都走保留注释的 YAML round-trip，文件里的手写注释与无关行不动。
- **宽版弹窗**：进入本分区时自动加宽宿主设置弹窗（官方将面板固定为 800×800 且无尺寸 API），切到其他分区即还原，不影响其余设置页。

## 生效时机

保存 / 启停 / 删除只是写 patch 文件，生效靠 HMR：宿主启用 HMR 时写入即刻热重载，运行中的会话下一个回复即可调用新服务器的工具；未启用 HMR 时重启后生效（面板会标明当前模式）。

## serverName 约定

- 匹配 `^[A-Za-z0-9_-]{1,32}$`（官方约束），决定模型看到的工具名前缀 `mcp__<serverName>__<tool>`；
- 全局唯一，重名的后加载行会失败，保存前有前置校验；
- 创建后行 id 固定为 `mcp-<serverName>`；编辑时改 serverName 只改工具前缀，行 id 不变。

## 连接兼容性备注（stdio 服务器实现方）

当前 DSH 捆绑的 MCP SDK（client 2.x）握手首步是新版 `server/discover` 探测（协议 2026-07-28）：正常服务器都会应答 discover 或按 JSON-RPC 规范回 `-32601`（客户端随即回落到经典 `initialize` 握手）；**静默忽略未知方法的极简 / 自制服务器会让连接永远停在「连接中」**。自制服务器务必对每个带 id 的请求都有响应（哪怕是错误对象）。

## 安全

与 [dsh-skills](../dsh-skills) 同一套同源请求约束：回环 Host 校验（拒绝 DNS-rebinding）、`sec-fetch-site` 跨站拒绝、2 MiB 请求体上限。写操作仅作用于两层用户 patch 文件，原子替换落盘。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-mcp
```

（或手动把 `@weilence/dsh-mcp` 加入宿主 `package.json` 的 `dependencies` 与 profile 的 `dsh.profile.bundles`，安装时 boot 会合并本包自带的 `cordis.patch.yml` 插入行。）安装后重启宿主生效；宿主启用 HMR 时刷新设置页即可看到「MCP 管理」菜单。

## 开发

```bash
pnpm --filter @weilence/dsh-mcp build      # tsdown 双产物（host ESM 内联 yaml / client CJS）
pnpm --filter @weilence/dsh-mcp typecheck
pnpm --filter @weilence/dsh-mcp test
```

机制与改动约定见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
