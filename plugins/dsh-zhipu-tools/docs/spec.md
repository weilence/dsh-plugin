# docs/spec.md — 功能与行为规格

本文件承载 @weilence/dsh-zhipu-tools 的行为规格与陷阱。插件只围绕一个功能：把智谱联网搜索与网页阅读注册为 web 服务的两个 provider，供官方设置页点名。全仓约定（双 half 架构、两层用户 patch、测试划分）见根 AGENTS.md 对应节。

## 定位

- host half 把智谱联网搜索与网页阅读（webReader）注册为 `ctx.web` 的两个 provider（`zhipu-search-api` / `zhipu-fetch-api`），官方工具名、参数与结果卡片保持原样，实际查询直调智谱 MCP 端点。
- provider 的选择完全归官方：「网页搜索与获取」设置页已把搜索与抓取拆成两个独立下拉，provider 列表动态加载（本插件的 provider 自动在列，另有「自动选择」）。本插件不自建配置入口、不写用户层配置——安装只注册，不改任何配置。
- 本插件是 host-only 形状：无 client half、无面板，插件详情页只有官方默认信息；loader 里的插件行仍由 cordis.patch.yml 插入，host half 靠它装载。
- 用量展示归 `dsh-models`。
- 安全边界：不经本地端口、不落状态文件；智谱凭据只在宿主进程内解析，不进入浏览器、不入日志。

## 源码结构与依赖

- `src/providers.ts`：`WebSearchProvider` / `WebFetchProvider` 适配层。搜索直通核心（核心已返回 web 服务同构类型，`maxResults` 由 web 服务统一截断——智谱侧无对应入参）；抓取把 webReader 的 Markdown 正文映射为 `statusCode: 200 + kind: 'text'`（提取失败由核心抛 `WebError`，不伪装成空页）；两者声明 `title`（官方设置页下拉按 `title ?? id` 显示，未声明就露原始 id）与 `description`（选中后在下拉下方展示的说明行，LocalizedText 由客户端按界面语言解析）；`available()` 须同步且不发网络——凭据在场性用快照表达（apply 时与凭据变更事件到达时刷新）。
- `src/search.ts`：智谱搜索核心（可调用函数，`ZhipuSearch = (query, signal?) => Promise<WebSearchResult>`）。每次搜索解析凭据、经 SDK 建立短连接、检查远端工具名称及 `search_query` schema、严格解析来源并关闭连接；请求禁止跟随携带 Bearer 的重定向。
- `src/reader.ts`：智谱网页阅读核心（webReader MCP），结构镜像 search.ts——短连接、工具发现 + `url` schema 检查、`redirect: 'error'`、严格解析。取正文的候选形状按序：单文本块 JSON（可双层编码）里的 `content` / `reader_result.content`（HTTP 契约嵌套层）→ 非 JSON 单文本块本身（MCP 可能直接回 Markdown）→ structuredContent；空白正文与无正文字段的形状明确报错；超时 60s（reader 侧页面抓取比搜索慢）。
- `src/index.ts`：apply 装配，`inject: ['credentials', 'web', 'configEditor']`；搜索与阅读共用 `requireKey`（见「Provider 侧」）；订阅 `credentials/reference-updated` 刷新凭据快照（见「Provider 侧」）；启动时读 locale 偏好解析下拉显示名（configEditor 只读）。
- `src/shared.ts`：两个 provider id、下拉显示名（按语言各一份）与选中说明、`KEY_REFS`（凭据候选引用名）单一事实源。
- `@modelcontextprotocol/client`：运行时直接依赖（search / reader 经 SDK 调智谱 MCP 端点）。
- 由宿主提供：`@deepseek-ai/dsh-web`（`WebError` 运行时值 + provider 类型 + `ctx.web` 合并）、`dsh-credentials`（凭据解析与 `credentials/reference-updated` 事件）。
- 构建为 host-only：tsdown 工厂缺省即不产出 client bundle，package.json 相应不声明 `dsh.client`。

## Provider 侧：注册与凭据

- 凭据解析：搜索与阅读共用 `requireKey`——同一把智谱凭据、同一套失败语义：解析故障抛 `WEB_PROVIDER_ERROR`，缺席才尝试次选 `ZAI_API_KEY`，首选解析失败不切换。密钥直接复用智谱模型凭据，无独立令牌、无配置里的密钥引用，轮换自动跟随。
- 下拉显示名：启动时读宿主 user-settings 的 locale 偏好（`configEditor` 只读，与官方语言设置同一事实源）——显式 `zh*` 用中文，其余（含缺席 = 跟随浏览器）用英文；运行中改语言需重启宿主或 HMR 重载后生效。选中说明走 `description` 的 LocalizedText，由客户端按界面语言解析（未命中语言回退 en），无启动快照问题。
- 凭据快照刷新点：apply 时首查；此后 `credentials/reference-updated` 事件点名 `KEY_REFS` 之一即重查（provider 写入或存储变更提交后触发；解析故障原文进日志）——补配后无需重启。进程环境变量的变化不可观测，重启宿主即重读。
- provider 注册经 `ctx.effect` 随本插件 fiber 生灭：HMR 重载自动换新，卸载即从注册表消失——seam 随后报 `WEB_PROVIDER_CONFIGURED_MISSING`。

### 陷阱

- `available()` 快照可能滞后：滞后 `true` 时失败由 `requireKey` 的 `WebError` 兜底，滞后 `false` 时 seam 报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`——两种都是清晰失败，不做后台轮询（取舍见 docs/decisions.md）。
- 智谱未公布稳定的搜索输出结构：远端形状变化须明确报错，不能将解析失败当成零结果。
- 卸载或禁用本插件后 `web` 行仍点名 `zhipu-search-api` / `zhipu-fetch-api`：`web_search` 会报 `WEB_PROVIDER_CONFIGURED_MISSING`（清晰的失败）；重装插件，或先在官方「网页搜索与获取」页改选其他提供方再卸载即无残留。

## 合规风险

- 智谱 Coding Plan 对 DSH 的套餐适用性尚须由智谱确认：智谱使用须知将 Coding Plan 权益限定于指定工具，MCP 文档所称兼容客户端不等于 DSH 已获套餐适用确认——勿将技术上可连接理解为套餐权益保证（使用须知链接见 README）。
