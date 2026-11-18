# dsh-mcp 陷阱

本文件承载实证事实、易错点、禁止事项与排查线索；行为规格见 [docs/spec.md](spec.md)，取舍理由见 [docs/decisions.md](decisions.md)。

- 实证——MCP SDK（client 2.x）握手首步是 `server/discover` 探测（协议 2026-07-28）且无超时：正常服务器应答 discover 或按 JSON-RPC 规范回 `-32601`（客户端随即回落经典 `initialize` 握手）；静默忽略未知方法的极简 / 自制服务器会永远停在「连接中」。排查连接问题先看服务器是否对每个带 id 的请求都有响应。
- 禁止——stdio 探测 spawn 不用 `node:child_process` 直接 spawn 加 `shell: true`：shell 会把 command 与 args 拼成一条 cmd 命令行，带空格路径（Program Files 下的 node）与内联脚本（`-e` 的引号 / 括号）全部失真，且命令不存在时 Windows 报 exit 1 而非 ENOENT；cross-spawn 与官方 mcp-client（MCP SDK）同源，两平台行为一致。
- 易错——连接检查默认 20s 超时：stdio 首次 npx 下载可能超时（属预期，可跳过检查），勿据此直接判断配置错误；stdio 探测会再启动一个实例，绑定固定端口的服务器可能因此检查失败。
- 易错——`loader.create` 的参数类型按「无 id」声明（缺省随机生成），运行时 `ensureId` 对显式 id 原样保留：diff 依赖稳定 id，必须带 id 传入（类型上做一次收窄）。
- 易错——watcher 必须盯目录不盯文件：tmp+mv 原子替换换 inode，盯文件会漏事件。
- 易错——勿把动态条目当持久配置：Loader 根树是内存态（`write()` 为 no-op），不会写回任何配置文件；持久化只认两份 `.mcp.json`。
- 易错——工作区档未挂载先查 client 是否上报过 cwd：宿主刚启动、客户端未连时不挂载属预期，不是故障；面板打开时每次 list 都带 cwd 兜底。
- 禁止——只动自己 `mcpx-` 前缀条目：行 id 被其他插件占用时跳过并告警、不劫持；cordis.patch.yml 与其他插件挂的 MCP 行一律不读取、不展示、不修改。
- 内联依赖事实——host half 内联 `@deepseek-ai/cordis-plugin-loader`（live.ts / mcpApply.ts 用其类型与 `Group` 判定；其对 cordis / cosmokit 的引用自动外置——cordis 由宿主供给、cosmokit 在 dependencies 里随安装解析）；`cross-spawn` 是生产依赖、自动外置。内联依赖的通用规则见根 `docs/architecture.md`。
