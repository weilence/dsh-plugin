# @weilence/dsh-mcp

设置页「MCP 管理」插件。心智模型：两份 `.mcp.json`（全局 `~/.dsh/mcp.json` 与工作区 `<工作区>/.mcp.json`）是唯一持久化事实源，Loader 里的 mcp-client 行由本插件按文件内容动态挂载、只存内存，重启后从文件重放——理解任何改动都沿「文件怎么写 → 挂载怎么变」这条主线；cordis.patch.yml 与其他插件挂的 mcp-client 行不归本插件管。全仓约定（双 half、多语言、面板原语、测试分层）见根 AGENTS.md 文档索引。

## 实现约束

- 只动自己 `mcpx-` 前缀条目：行 id 被其他插件占用时跳过并告警，不劫持；patch 行与其他插件的 MCP 行一律不读取、不展示、不修改。
- 写请求一律携带读取时的 revision（内容哈希），冲突即 409 提示刷新，不得盲目覆盖。
- 挂载 diff（create / update / remove）全走 `ctx.loader` 运行时 API 当场生效，无 HMR、无重启依赖，不写 patch。
- `.mcp.json` 写回保留键集与键序（含未知键与顶层额外键），无效条目原样保留、不代改。
- `loader.create` 必须带稳定 id 传入（运行时原样保留，类型上做一次收窄），diff 依赖它。
- stdio 探测 spawn 用 cross-spawn（与官方 StdioClientTransport 同源），禁用 `node:child_process` + `shell: true`。

## 文档索引

- [docs/spec.md](docs/spec.md)：行为规格——插件定位、结构导览、`.mcp.json` 方言、挂载与生效链路、面板行为语义。
- [docs/traps.md](docs/traps.md)：实证事实、易错点、禁止事项（MCP SDK 握手、shell spawn、`loader.create` id 等）。
- [docs/decisions.md](docs/decisions.md)：行为取舍与拍板理由。
- [docs/tests.md](docs/tests.md)：测试地图——各测试文件覆盖什么、如何运行。
- [README.md](README.md)：面向用户的功能与安装说明（只读参考）。
