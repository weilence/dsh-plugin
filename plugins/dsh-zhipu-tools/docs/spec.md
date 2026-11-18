# docs/spec.md — 功能与行为规格

本文件承载 @weilence/dsh-zhipu-tools 的行为规格与陷阱。插件只围绕一个功能：面板开关把内置 Web 搜索切到智谱，链路为 provider 注册与凭据 → configEditor 开关写入 → 面板呈现与实时同步。全仓约定（双 half 架构、多语言词典、面板原语、两层用户 patch、测试划分）见根 AGENTS.md 对应节。

## 定位

- host half 把智谱联网搜索与网页阅读（webReader）注册为 `ctx.web` 的两个 provider（`zhipu-search-api` / `zhipu-fetch-api`），官方工具名、参数与结果卡片保持原样，实际查询直调智谱 MCP 端点。
- 面板单开关经官方 `configEditor` 成对读写 `web` 行的两个 provider 键——不转发线协议、不手写 patch 文件。
- 用量展示归 `dsh-models`。
- 安全边界：不经本地端口、不落状态文件；智谱凭据只在宿主进程内解析，不进入浏览器、不入日志。

## 源码结构与依赖

- `src/providers.ts`：`WebSearchProvider` / `WebFetchProvider` 适配层。搜索直通核心（核心已返回 web 服务同构类型，`maxResults` 由 web 服务统一截断——智谱侧无对应入参）；抓取把 webReader 的 Markdown 正文映射为 `statusCode: 200 + kind: 'text'`（提取失败由核心抛 `WebError`，不伪装成空页）；`available()` 须同步且不发网络——凭据在场性用快照表达（host apply 时与状态路由每次读取时刷新）。
- `src/search.ts`：智谱搜索核心（可调用函数，`ZhipuSearch = (query, signal?) => Promise<WebSearchResult>`）。每次搜索解析凭据、经 SDK 建立短连接、检查远端工具名称及 `search_query` schema、严格解析来源并关闭连接；请求禁止跟随携带 Bearer 的重定向。
- `src/reader.ts`：智谱网页阅读核心（webReader MCP），结构镜像 search.ts——短连接、工具发现 + `url` schema 检查、`redirect: 'error'`、严格解析。取正文的候选形状按序：单文本块 JSON（可双层编码）里的 `content` / `reader_result.content`（HTTP 契约嵌套层）→ 非 JSON 单文本块本身（MCP 可能直接回 Markdown）→ structuredContent；空白正文与无正文字段的形状明确报错；超时 60s（reader 侧页面抓取比搜索慢）。
- `src/index.ts`：apply 装配，`inject: ['credentials', 'web', 'webServer', 'configEditor']`；搜索与阅读共用 `requireKey`（见「Provider 侧」）；承载两个面板路由（见「开关写入」）。
- `src/shared.ts`：双端 wire 常量——`KEY_REFS` 单一事实源、两个 provider id、两条路由路径、`StatusView` 含 `enabled`。
- `src/client/`：接入面板（形态见「面板」）；`projectConfig` 纯投影可单测（签名 `projectConfig(t, view)`）。
- `src/client/locales.ts`：本插件词典，命名空间 `dsh-zhipu-tools`；注册 / 绑定 / `makeT` 取词机制见[根 docs/i18n.md](../../../docs/i18n.md)「多语言约定」。
- `@modelcontextprotocol/client`：运行时直接依赖（search / reader 经 SDK 调智谱 MCP 端点）。
- 由宿主提供：`@deepseek-ai/dsh-web`（`WebError` 运行时值 + provider 类型 + `ctx.web` 合并）、`dsh-credentials`、host-webserver、dsh-config-editor（`ctx.configEditor` 合并）。
- client half 的 `dsh.client.inject` 额外声明 `@deepseek-ai/dsh-api-remotes`（`ctx.remote.$on` 事件订阅，`document-updated` 已在 remotes 转发表注册）。

## Provider 侧：注册与凭据

- 凭据解析：搜索与阅读共用 `requireKey`——同一把智谱凭据、同一套失败语义：解析故障抛 `WEB_PROVIDER_ERROR`，缺席才尝试次选 `ZAI_API_KEY`，首选解析失败不切换。密钥直接复用智谱模型凭据，无独立令牌、无配置里的密钥引用，轮换自动跟随。
- provider 注册经 `ctx.effect` 随本插件 fiber 生灭：HMR 重载自动换新，卸载即从注册表消失——seam 随后报 `WEB_PROVIDER_CONFIGURED_MISSING`。

### 陷阱

- `available()` 快照可能滞后（凭据在别处变更后、下一次状态读取前）：滞后 `true` 时失败由 `requireKey` 的 `WebError` 兜底，滞后 `false` 时 seam 报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`——两种都是清晰失败，不做后台轮询（取舍见 docs/decisions.md）。
- 智谱未公布稳定的搜索输出结构：远端形状变化须明确报错，不能将解析失败当成零结果。
- 卸载或禁用本插件后 `web` 行仍指向 `zhipu-search-api` / `zhipu-fetch-api`：`web_search` 会报 `WEB_PROVIDER_CONFIGURED_MISSING`（清晰的失败）；重装插件，或先把开关拨回关闭（恢复部署默认）再卸载即无残留。

## 开关写入：路由与 wire 契约

- `GET /dsh-zhipu-tools/status`：现查凭据（顺带刷新 available 快照）并判定 `enabled`——经 `configEditor.configuration()` 取生效选择（profile 覆盖非空以覆盖为准，否则取下层组合值）；两键都点名本插件才算开（对齐官方卡片的成对语义，混合态按关闭展示）。
- `POST /dsh-zhipu-tools/web-config`：请求体 `{enabled: boolean}`（非布尔 400）。开启须凭据在场（缺席 409，关闭不需要凭据）；写入必须走 `ctx.configEditor.edit`——开启先清旧版按钮写过的 `web-deepseek-api` 覆盖行（`change` 返回 `inherited` 即官方「相等即清除」语义）再写 `web` 行两键点名本插件 provider；关闭即 `web` 行 next=inherited 清除覆盖、回退部署默认——不把官方 provider id 写死进用户 patch。文件锁、HMR 串行、schema 校验、home 层覆盖检测、原子写与失败回滚全部由官方保障，禁止绕开手写 patch 文件。响应即写入后的完整状态视图，客户端无需二次读取。

### 陷阱

- `web` 行必须显式点名本插件的 provider：宿主 0.2.2-rc.4 起基础组合只固定 `fetchProvider: http`，`searchProvider` 缺省走自动选择——未配置时 seam 先选路由指定的官方 provider（DeepSeek 模型路由用 `deepseek-official`，其余路由与模型外搜索用 `deepseek-search-api`），优先者不可用且恰好只剩一个可用 provider 才自动选中（配了智谱凭据而无 DeepSeek Key 时，非 DeepSeek 路由的搜索会静默落到本插件），剩多个才报 `WEB_PROVIDER_AMBIGUOUS`。
- `configEditor.edit` 的 change 里不要整份展开 `inherited` 进 next：会把部署默认值全量固化进用户层。关闭开关走 next=inherited 整行清除（官方「相等即清除」）；开启只叠加本插件的两个点名键。
- 用户此前经旧版本按钮写入的 `web-deepseek-api` 行指向已消亡的本地端点：开启开关会顺带清除；若清除被 home 层覆盖拒绝，报错原文透传面板，不静默放弃。
- 若 home 层 patch 或 `--patch` 覆盖了 `web` 行，开关写入会被 `configEditor` 明确拒绝（不产生表面成功的切换）：按提示移除上层覆盖后重试。

## 面板：交互与实时同步

- 面板保持极简（插件详情页 `Panel` 无头部，属[根 docs/panel.md](../../../docs/panel.md)「面板交互约定」的既定例外）：单行行式布局对齐官方 Web search 卡片（`ConfigSection.module.css` 的 feature / toggleRow）——左「Web 搜索走智谱」文案右官方 `Switch`，行下 `shared.hint` 一行行为辅助文案。
- `Switch` 受控于服务端 `enabled`，写入进行中禁用；凭据缺失不禁用——关闭方向仍合法，开启被拒的原文留在错误行。
- 行尾凭据徽标仅在凭据不可用时出现（`Pill` warn 色调「未配置」，`title` 悬停给引用名或故障原文；在 label 外，点击不切换开关）。
- Host 失败原文原样透传错误行；store 的 toggle 成功以响应视图为准（开关状态只认服务端事实）；接入路径的完整说明归 README。
- client `apply` 经 `ctx.remote.$on('settings/document-updated')` 订阅配置文档变更（remotes 通道把宿主该事件广播给所有客户端，外部改 patch、官方设置页写入均会触发）：收到 `web` 行的更新即刷新 store（写入进行中跳过），开关状态与配置实时一致。

## 合规风险

- 智谱 Coding Plan 对 DSH 的套餐适用性尚须由智谱确认：智谱使用须知将 Coding Plan 权益限定于指定工具，MCP 文档所称兼容客户端不等于 DSH 已获套餐适用确认——勿将技术上可连接理解为套餐权益保证（使用须知链接见 README）。
