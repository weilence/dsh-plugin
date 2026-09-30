# @weilence/dsh-zhipu-tools

DSH web 插件：设置页「智谱搜索」开关——把官方 `web_search` 的搜索后端切换为智谱联网搜索，默认不替换；同时挂载智谱官方搜索 / 网页阅读 MCP 工具。

## 功能

- **搜索替换开关（默认关闭）**：安装后官方 `web_search` 仍走 DeepSeek 搜索。在设置页「智谱搜索」打开开关后，工具名、参数与结果卡片保持官方原样，实际查询改走智谱；连接或解析失败时明确报错，不会暗中回退。每次调用建立短连接并取得当次凭据。
- **写入位置**：开关读写两层用户配置文件（profile 层 `<profile>/cordis.patch.yml`、home 层 `~/.dsh/cordis.patch.yml`）。已写过 web 配置的就地修改那一行（原值记入注释、关闭时可恢复），两层都没写过的在 home 层新建。开发模式（HMR）下写入后宿主自动重整、无需重启；打包部署的宿主面板提示需重启。
- **状态如实展示**：以宿主运行时实际生效值为准；配置来自启动参数 `--patch`（优先级最高、文件改不动）或 web 服务未加载时，开关置灰并说明原因。
- **MCP 工具**：继续挂载 `zhipu_search`（`mcp__zhipu_search__web_search_prime`，含 `search_domain_filter`、`search_recency_filter` 等参数）与 `zhipu_reader` 两台 MCP 服务器，不受开关影响；连接重试与工具同步由宿主 in-box mcp-client 承担。官方 `web_fetch` 仍使用 `http` 提供者，Reader 不能提供其所需的 HTTP 状态码等信息，二者不等价。
- **用量展示**：由独立的 `@weilence/dsh-models` 插件承载；同时安装时，切换至 `zai-coding-cn` 会显示智谱剩余额度。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-zhipu-tools
```

（或手动把 `@weilence/dsh-zhipu-tools` 加入宿主 `package.json` 的 `dependencies` 与 profile 的 `dsh.profile.bundles`。）安装后重启宿主生效。

## 配置

优先配置 `zai-coding-cn` 供应商的 `ZAI_CODING_CN_API_KEY`；仅当该凭据缺席时才尝试 `ZAI_API_KEY`，解析故障不会切换账户。没有有效凭据时打开开关可用，但 `web_search` 调用会返回明确错误。

注意事项：

- 开着替换时卸载本插件，请先在面板关闭替换，否则残留的配置行会让 `web_search` 报「找不到智谱提供者」；面板在开启态常驻此提示。
- 手写过 `id: web` 配置行的用户：开启会就地修改那一行（只动 `searchProvider` 一个键、原值记注释），关闭时恢复原值。
- 智谱的[使用须知](https://docs.bigmodel.cn/cn/coding-plan/usage-notes.md)将 Coding Plan 权益限定于指定工具；MCP 文档所称兼容客户端不等于 DSH 已获套餐适用确认。请先向智谱核实此场景的授权和计费，勿将技术上可连接理解为套餐权益保证。

## 开发

```bash
pnpm --filter @weilence/dsh-zhipu-tools build
pnpm --filter @weilence/dsh-zhipu-tools typecheck
pnpm --filter @weilence/dsh-zhipu-tools test
```

机制与改动约定见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
