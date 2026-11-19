# dsh-mcp 行为规格

本文件承载 @weilence/dsh-mcp 的功能与行为规格：是什么、怎么表现；取舍理由见 [docs/decisions.md](decisions.md)，易错与禁止事项见 [docs/traps.md](traps.md)，测试见 [docs/tests.md](tests.md)；全仓约定见根 AGENTS.md 文档索引，本文只记插件特有事实。

## 插件定位

- 全局面板「MCP 管理」插件：以两份 `.mcp.json`（全局 `~/.dsh/mcp.json` 与工作区 `<工作区>/.mcp.json`）为持久化事实源，把其中的 MCP 服务器动态挂载 / 更新 / 卸载进 Loader 的 mcp-client 行，并实时展示每个服务器的连接状态与已注册工具。
- 作用域仅这两份文件：cordis.patch.yml / cordis.yml 里直接声明的行与其他插件挂的 mcp-client 行一律不读取、不展示、不修改。
- HTTP 层走与 dsh-skills 同一套同源请求约束：回环 Host 校验（拒绝 DNS-rebinding）、`sec-fetch-site` 跨站拒绝、2 MiB 请求体上限，统一经 `@dsh-plugins/shared/http`（机制见根 `docs/architecture.md`）；写操作仅作用于两份 `.mcp.json`，tmp+mv 原子落盘。
- 双 half 架构、生效边界、多语言词典、面板原语等全仓约定见根 `docs/architecture.md` / `docs/i18n.md` / `docs/panel.md`；本文只记插件特有事实与偏离。

## 结构导览

- `src/index.ts`：host half，六个 HTTP 路由（list / cwd / save / check / set-enabled / delete）+ 启动重放、文件 watcher、工作区档 cwd 跟随。
- `src/mcpFile.ts`：`.mcp.json` 文件方言——解析（合法 / 无效条目分流）、mcp-client Config 双向映射、原子落盘（tmp+mv）、内容哈希 revision（乐观并发）；JSON 无注释可保，round-trip 保留键集与键序（含未知键与顶层额外键）。
- `src/mcpApply.ts`：文件期望集 ↔ Loader 实例的挂载 diff（create / update / remove 全走 `ctx.loader` 运行时 API）；只动自己 `mcpx-` 前缀条目，行 id 被其他插件占用时跳过并告警、不劫持。
- `src/mcpConfig.ts`：配置校验（`normalizeDraft` 对齐官方 mcp-client Config schema）与标准 MCP JSON 粘贴解析（`fromStandardJson` / `toStandardJson`，仅 client 消费）；转换备注（notes）、单台服务器问题（problems）、顶层 ConfigError 带词典描述子（`PanelMessage`），浏览器渲染期取词；host 校验失败是纯 message（errMsg 过线，按 `{text}` 原样展示）。
- `src/probe.ts`：保存前的连接检查——stdio 经 cross-spawn 启动子进程（与官方 StdioClientTransport 相同、args 直接传递不经 shell 插值），HTTP 直接发送 initialize 握手，超时可注入。
- `src/live.ts`：Loader / 工具注册表运行态内省（官方 `Loader` / `ToolRuntime` 类型，服务不可用时降级）；list 只取 `mcpx-` 前缀条目。
- `src/shared.ts`：双端 wire 类型与常量（`ENTRY_PREFIX` / 文件名 / 路由路径 / `entryIdOf`）。
- `src/client/locales.ts`：本插件词典，命名空间 `dsh-mcp`（词典形态与注册方式见根 `docs/i18n.md`）；`PanelMessage`（`{key, params}` 或 `{text}`）是 store / 解析层的消息描述子，渲染期经 `messageText` 取词；单测取词用 `test/i18n.ts` 的 `makeT`。
- `src/client/`：全局面板页 `McpPanelPage.tsx`（挂 root 作用域 `main` keyed 槽位，页壳 `PanelPage` 来自 `@dsh-plugins/client-ui`）、侧栏入口图标 `McpPanelIcon.tsx`（挂 `sidebar.panellist`，点击由侧栏外壳调 `layout.selectPanel` 打开）与 `src/client/store.ts` 状态（语义见下两节）；`t` 经框架 seat 进页面根后 props 下传，公共词取消 / 关闭 / 删除 / 保存走 common 词条（机制见根 `docs/i18n.md`）；HTTP 封装自定义头 `x-dsh-mcp`。
- `src/client.tsx`：订阅官方 sessions.list 快照，把主视图会话 cwd（`retainedBy.mainView > 0`）经 `/dsh-mcp/cwd` 上报 host 并同步进 store（工作区档定位事实源；上报失败静默，list 请求携带 cwd 兜底）。

## `.mcp.json` 方言

- 两份文件：全局 `~/.dsh/mcp.json`、工作区 `<工作区>/.mcp.json`（文件名与位置对齐 Claude Code / Cursor 的项目惯例，理由见 docs/decisions.md）。
- 外层键即服务器名（serverName），匹配 `^[A-Za-z0-9_-]{1,32}$`（官方约束），决定模型看到的工具名前缀 `mcp__<serverName>__<tool>`，故全局唯一。
- 解析时合法 / 无效条目分流：无效条目（名称非法、缺 command / url、类型不对）在文件里原样保留（写回身份不变），面板展示原因并允许删除，修复走手工改文件。
- JSON 无注释可保：round-trip 保留键集与键序（含未知键、顶层 `$schema` 等额外键），写回统一两空格缩进。
- `disabled` 转换为行级停用扩展键；表单覆盖常用键：stdio `command` / `args` / `env` / `cwd` 与 streamable-http `url` / `headers`，及 `toolCallTimeoutMs`、`failOnStartupError`；高级键（`reconnect`、`maxInstructionBytes`）在编辑 JSON 视图可见可改、随草稿原样往返、保存时显式提交。
- 粘贴解析接受业界标准 MCP JSON：`mcpServers` 包装 / 直接映射 / 单个服务器对象。
- 同名即编辑（覆盖写入）、新名即创建、改名 = 删除后新建；跨档同名是遮蔽语义：工作区档生效、全局档 `shadowed` 且不挂载，删除工作区档条目即恢复（理由见 docs/decisions.md）。
- 写并发：文件内容哈希作 revision，写请求一律携带读取时的 revision，外部修改后 409 提示刷新；工作区档写请求缺 cwd 时 409（等待 client 上报）。
- 与不可管来源（patch 行等）重名时，挂载因官方 serverName 命名空间冲突而失败，错误摘要显示在卡片上。

## 挂载与生效链路

- 插件 apply 时读全局档并重放挂载；工作区档等 client 上报 cwd 后挂载，切换工作区时旧项目条目卸载、新项目条目挂载。
- watcher：`fs.watch` 目录级 + 文件名过滤，200ms 稳定窗口，盯两份文件——手工编辑同样即时生效（盯目录不盯文件的原因见 docs/traps.md）。
- 保存 / 启停 / 删除 = 写文件（revision 校验）→ 全量 diff 同步挂载；没有 HMR 依赖、没有重启需求，挂载走 Loader 运行时 API 当场生效。
- 动态条目只存在于内存（Loader 根树不可持久化，`write()` 为 no-op），不写回任何配置文件；重启后由插件启动时从两份文件重放。
- 插件卸载时 remove 自己名下全部条目、关闭 watcher；patch 行与其他插件不受影响。
- 保存前一律经 check 接口做 initialize 握手探测：失败展示原因，再点一次「保存」显式跳过；任何输入变动都会重置该跳过标记（取舍见 docs/decisions.md）。
- 运行态内省经 `src/live.ts` 读 Loader / 工具注册表；面板侧 fiber 转变无推送通道，store 以轮询跟进（起停语义见下节，取舍见 docs/decisions.md）。

## 面板行为语义

- 服务器为可展开卡片：点击行即可在行内新建 / 编辑 / 查看（McpServerForm / McpServerView）；服务器名即文件里的键，编辑时锁定。
- 列表行展示传输形态、端点、配置；每个服务器显示 fiber 状态（连接中 / 失败含错误摘要 / 已停用 / 未挂载），运行中带工具数（「运行中（N 工具）」），点徽标打开 `mcp__<serverName>__*` 清单弹窗（可搜索过滤，全名可复制）。
- 工具行与 dsh-skills 同形：裸 select 档位下拉（全局 / 工作区，localStorage 记忆，收窄的紧凑宽度）+ `SearchBox` 过滤（名称 / 端点 / 错误摘要）+ 动作按钮；原语与搜索框规范见根 `docs/panel.md`。
- JSON 粘贴无解析 / 导入步骤，「保存」一次完成解析、连接检查与落盘；编辑 JSON 视图由 `toStandardJson` 从草稿生成（`type` 承载 transport、行级 disabled 停用时显式输出），解析回填经 `fromStandardJson`，转换备注实时渲染于 JSON 输入区下方。
- revision / cwd 由 store 按快照统一附到写请求。
- store 过渡态轮询：快照存在过渡态行（fiber pending / loading / unloading 的「连接中…」）时自动轮询刷新，落定即停、面板关闭（无订阅者）即停。
