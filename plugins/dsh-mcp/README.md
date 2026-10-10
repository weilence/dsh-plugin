# @weilence/dsh-mcp

DSH web 插件：在设置页新增「MCP 管理」菜单，以两份 `.mcp.json` 文件（全局 `~/.dsh/mcp.json` 与工作区 `<工作区>/.mcp.json`）为持久化事实源，把其中的 MCP 服务器动态挂载进官方 [mcp-client](https://github.com/deepseek-ai/deepseek-harness/tree/develop/packages/mcp/mcp-client)，并实时展示每个服务器的连接状态与已注册工具。

## 功能

- **目录**：工具行区分全局 / 工作区两档（下拉选择，档位记忆），配搜索框过滤（名称 / 端点 / 错误摘要）；列表展示传输形态、端点、配置。无效条目（名称非法、缺 command / url 等）原样展示原因，可删除，不影响其余条目。
- **运行态**：每个服务器显示 fiber 状态（连接中 / 失败含错误摘要 / 已停用 / 未挂载），运行中状态带工具数（运行中 · N 工具），点该徽标直接打开 `mcp__<serverName>__*` 清单弹窗（可搜索过滤，全名可复制）；存在连接中的服务器时面板自动轮询跟进，落定即停。
- **动态挂载**：保存 / 启停 / 删除即写文件并即刻 diff 应用到 Loader——新增服务器当场创建连接、改配置当场重挂、删除当场卸载，无需 HMR、无需重启；手工编辑文件也一样，watcher（约 200ms 稳定窗口）会自动跟进。动态条目只存在于内存（Loader 根树不可持久化），重启后由插件启动时从两份文件重放。
- **新建 / 编辑**：表单覆盖两种传输形态的常用键（stdio 的 `command`/`args`/`env`/`cwd` 与 streamable-http 的 `url`/`headers`，及 `toolCallTimeoutMs`、`failOnStartupError`），也支持 JSON 直接粘贴；粘贴按业界标准 MCP JSON（`mcpServers` 包装 / 直接映射 / 单个服务器对象）解析，高级键（`reconnect`、`maxInstructionBytes`）在编辑 JSON 视图中可见可改、原样往返；`disabled` 转换为文件里的行级停用扩展键。服务器名即文件里的键，编辑时锁定（改名 = 删除后新建）。
- **同名遮蔽**：工作区档与全局档同名时，工作区档生效、全局档标记「被工作区档遮蔽」不挂载（对齐 Claude Code 的项目覆盖语义）；删除工作区档条目后全局档自动恢复。
- **写盘双保险**：所有写操作携带读取时的文件内容版本做乐观并发，外部修改后冲突（409）提示刷新；文件落盘 tmp+mv 原子替换。JSON 无注释可保，写回统一两空格缩进，键集与键序（含未知键、顶层 `$schema` 等额外键）身份保留。
- **宽版弹窗**：进入本分区时自动加宽宿主设置弹窗（官方将面板固定为 800×800 且无尺寸 API），切到其他分区即还原，不影响其余设置页。

## 作用域

- **全局档** `~/.dsh/mcp.json`：插件启动即读取并挂载。
- **工作区档** `<工作区>/.mcp.json`：跟随主视图会话的工作目录（对齐 Claude Code / Cursor 的项目惯例名称与位置）；client 侧把主视图 cwd 实时上报给 host，切换工作区时旧项目条目卸载、新项目条目挂载。工作区档在 web 客户端上报过 cwd 之后才生效。
- 不归本插件管的 MCP：cordis.patch.yml / cordis.yml 里直接声明的行、其他插件挂的 mcp-client 行——一律不读取、不展示、不修改。

## serverName 约定

- 服务器名匹配 `^[A-Za-z0-9_-]{1,32}$`（官方约束），决定模型看到的工具名前缀 `mcp__<serverName>__<tool>`；
- 两份文件之间重名走遮蔽语义；与不可管的来源（patch 行等）重名时，挂载会因官方 serverName 命名空间冲突而失败，错误摘要显示在卡片上。

## 连接兼容性备注（stdio 服务器实现方）

当前 DSH 捆绑的 MCP SDK（client 2.x）握手首步是新版 `server/discover` 探测（协议 2026-07-28）：正常服务器都会应答 discover 或按 JSON-RPC 规范回 `-32601`（客户端随即回落到经典 `initialize` 握手）；**静默忽略未知方法的极简 / 自制服务器会让连接永远停在「连接中」**。自制服务器务必对每个带 id 的请求都有响应（哪怕是错误对象）。

## 安全

与 [dsh-skills](../dsh-skills) 同一套同源请求约束：回环 Host 校验（拒绝 DNS-rebinding）、`sec-fetch-site` 跨站拒绝、2 MiB 请求体上限。写操作仅作用于两份 `.mcp.json`，原子替换落盘。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-mcp
```

（或手动把 `@weilence/dsh-mcp` 加入宿主 `package.json` 的 `dependencies` 与 profile 的 `dsh.profile.bundles`，安装时 boot 会合并本包自带的 `cordis.patch.yml` 插入行。）安装后重启宿主生效；宿主启用 HMR 时刷新设置页即可看到「MCP 管理」菜单。

## 开发

```bash
pnpm --filter @weilence/dsh-mcp build      # tsdown 双产物（host ESM 内联依赖 / client CJS）
pnpm --filter @weilence/dsh-mcp typecheck
pnpm --filter @weilence/dsh-mcp test
```

机制与改动约定见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
