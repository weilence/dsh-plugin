# @weilence/dsh-zhipu-tools

DSH web 插件：把智谱联网搜索与网页阅读（webReader）注册为 `web_search` / `web_fetch` 的可选 provider（`zhipu-search-api` / `zhipu-fetch-api`），在官方设置页「网页搜索与获取」点名即用——不转发线协议、不需要 DeepSeek 账号或 API Key。

## 功能

- **原生 provider**：host half 经 `ctx.web` 注册两个 provider，官方工具名、参数与结果卡片保持原样，实际查询直接调智谱 MCP 端点；连接或解析失败时明确报错，不会暗中回退。下拉显示名跟随设置里显式选择的语言（启动时快照）：中文显示「智谱联网搜索」/「智谱网页阅读」，其余情况（含跟随浏览器）显示英文名；选中后下方各有一行按界面语言显示的说明。搜索的 `maxResults` 由 web 服务统一截断；抓取返回 webReader 提取的 Markdown 正文（成功即 200、目标无可用内容即明确失败，口径对齐官方 Fetch API provider）。
- **选择回归官方设置页**：官方「网页搜索与获取」页把「网页搜索提供方」「网页获取提供方」拆成两个独立下拉，provider 列表动态加载，本插件的 provider 自动在列。本插件不自建配置入口：安装只注册 provider，不改任何配置；要固定路由就在官方页面显式点名。
- **密钥直接复用智谱**：provider 每次调用解析智谱模型的 `ZAI_CODING_CN_API_KEY`（缺席时回退 `ZAI_API_KEY`），无独立令牌、无配置里的密钥引用，轮换自动跟随。凭据未配置时 provider 照常注册但明确报告不可用（`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`）；补配后无需重启。
- **安全边界**：不经本地端口、不落状态文件；智谱凭据只在宿主进程内解析，不进入浏览器、不入日志。
- **用量展示**：由独立的 `@weilence/dsh-models` 插件承载；同时安装时，切换至 `zai-coding-cn` 会显示智谱剩余额度。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-zhipu-tools
```

安装后重启宿主生效。需要宿主 0.2.2-rc.5 及以上（web 服务 provider 注册接口与 0.2.2-rc.4 起的搜索自动选择语义）。

## 配置

优先配置 `zai-coding-cn` 供应商的 `ZAI_CODING_CN_API_KEY`；仅当该凭据缺席时才尝试 `ZAI_API_KEY`，解析故障不会切换账户。没有有效凭据时 provider 照常注册但报告不可用，`web_search` 调用会返回明确错误。

注意事项：

- 卸载或禁用本插件后，`web` 行仍点名 `zhipu-search-api` / `zhipu-fetch-api`：`web_search` 会报 `WEB_PROVIDER_CONFIGURED_MISSING`（清晰的失败）；重装插件，或先在官方「网页搜索与获取」页改选其他提供方再卸载即无残留。
- 宿主 0.2.2-rc.4 起内置组合不再固定 `searchProvider`：未做选择时，DeepSeek 模型会话的搜索自动走 `deepseek-official`（Messages 搜索），其余搜索优先 `deepseek-search-api`。若未配置 DeepSeek Key 使后者不可用、而智谱凭据已配置，本插件会成为唯一可用的搜索 provider 被自动选中——未显式点名也可能在这类搜索中走智谱。在官方「网页搜索与获取」页明确选择提供方即可固定路由。
- 智谱的[使用须知](https://docs.bigmodel.cn/cn/coding-plan/usage-notes.md)将 Coding Plan 权益限定于指定工具；MCP 文档所称兼容客户端不等于 DSH 已获套餐适用确认。请先向智谱核实此场景的授权和计费，勿将技术上可连接理解为套餐权益保证。
