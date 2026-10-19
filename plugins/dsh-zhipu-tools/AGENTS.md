# @weilence/dsh-zhipu-tools

智谱 Web 搜索 provider + 开关接入：host half 把智谱联网搜索与网页阅读注册为 `ctx.web` 的两个 provider（`zhipu-search-api` / `zhipu-fetch-api`），面板单开关经官方 `configEditor` 成对读写 `web` 行的两个 provider 键——**不转发线协议、不手写 patch 文件**。用量展示归 `dsh-models`。

## 结构与约定

- `src/providers.ts`：`WebSearchProvider` / `WebFetchProvider` 适配层。搜索直通核心（核心已返回 web 服务同构类型，`maxResults` 由 web 服务统一截断——智谱侧无对应入参）；抓取把 webReader 的 Markdown 正文映射为 `statusCode: 200 + kind: 'text'`（webReader 不报目标页状态码与最终 URL，口径对齐官方 Fetch API provider——「成功即目标页取回」，提取失败由核心抛 `WebError`，不伪装成空页）。`available()` 须同步且不发网络：凭据在场性用快照表达（host apply 时与状态路由每次读取时刷新）。
- `src/search.ts`：智谱搜索核心（可调用函数，`ZhipuSearch = (query, signal?) => Promise<WebSearchResult>`）。每次搜索解析凭据、经 SDK 建立短连接、检查远端工具名称及 `search_query` schema、严格解析来源并关闭连接；请求禁止跟随携带 Bearer 的重定向。智谱未公布稳定输出结构，变化须明确报错，不能将解析失败当成零结果。
- `src/reader.ts`：智谱网页阅读核心（webReader MCP），结构镜像 search.ts（短连接、工具发现 + `url` schema 检查、`redirect: 'error'`、严格解析）。取正文的候选形状按序：单文本块 JSON（可双层编码）里的 `content` / `reader_result.content`（HTTP 契约嵌套层）→ 非 JSON 单文本块本身（MCP 可能直接回 Markdown）→ structuredContent；**空白正文与无正文字段的形状明确报错**。超时 60s（reader 侧页面抓取比搜索慢）。
- `src/index.ts`：apply 装配。`inject: ['credentials', 'web', 'webServer', 'configEditor']`。搜索与阅读共用 `requireKey`（同一把智谱凭据、同一套失败语义：解析故障抛 `WEB_PROVIDER_ERROR`，缺席才尝试次选 `ZAI_API_KEY`，首选解析失败不切换）。provider 注册经 `ctx.effect` 随本插件 fiber 生灭（HMR 重载自动换新，卸载即从注册表消失——seam 随后报 `WEB_PROVIDER_CONFIGURED_MISSING`）。两个面板路由：`GET /dsh-zhipu-tools/status` 现查凭据（顺带刷新 available 快照）并判定 `enabled`——经 `configEditor.configuration()` 取生效选择（profile 覆盖非空以覆盖为准，否则取下层组合值），两键都点名本插件才算开（对齐官方卡片的成对语义，混合态按关闭展示）；`POST /dsh-zhipu-tools/web-config` 请求体 `{enabled: boolean}`（非布尔 400）：开启须凭据在场（缺席 409，关闭不需要凭据），**写入必须走 `ctx.configEditor.edit`**——开启先清旧版按钮写过的 `web-deepseek-api` 覆盖行（`change` 返回 `inherited` 即官方「相等即清除」语义）再写 `web` 行两键点名本插件 provider；关闭即 `web` 行 next=inherited 清除覆盖、回退部署默认——不把官方 provider id 写死进用户 patch。文件锁、HMR 串行、schema 校验、home 层覆盖检测、原子写与失败回滚全部由官方保障，禁止绕开它手写 patch 文件；响应即写入后的完整状态视图，客户端无需二次读取。
- `src/shared.ts`：双端 wire 常量（`KEY_REFS` 单一事实源、两个 provider id、两条路由路径、`StatusView` 含 `enabled`）；`src/client/`：接入面板保持极简——插件详情页头部已带插件名与描述，`Panel` 整体无头部；单行行式布局对齐官方 Web search 卡片（`ConfigSection.module.css` 的 feature / toggleRow）：左「Web 搜索走智谱」文案右官方 `Switch`（受控于服务端 `enabled`，写入进行中禁用；凭据缺失不禁用——关闭方向仍合法，开启被拒的原文留在错误行），行尾凭据徽标仅在凭据不可用时出现（正常一律不出声；`Pill` warn 色调「未配置」，`title` 悬停给引用名或故障原文；在 label 外，点击不切换开关），行下 `shared.hint` 一行行为辅助文案。Host 失败原文原样透传错误行；接入路径的完整说明归 README。client `apply` 经 `ctx.remote.$on('settings/document-updated')` 订阅配置文档变更（remotes 通道把宿主该事件广播给所有客户端，外部改 patch、官方设置页写入均会触发）：收到 `web` 行的更新即刷新 store（写入进行中跳过），开关状态与配置实时一致。`projectConfig` 纯投影可单测（签名 `projectConfig(t, view)`）。store 的 toggle 成功以响应视图为准（开关状态只认服务端事实），**成功不弹提示**——开关翻转本身就是结果；失败原文留在错误行。`src/client/locales.ts`：本插件词典（命名空间 `dsh-zhipu-tools`，zh 为键集事实源、en 编译期查全），client `apply` 经 `ctx.locale.register` 注册、`ctx.locale.bind` 绑定；单测取词用 `test/i18n.ts` 的 `makeT`。
- 依赖：`@modelcontextprotocol/client` 是运行时直接依赖（search / reader 经 SDK 调智谱 MCP 端点）；`@deepseek-ai/dsh-web`（`WebError` 运行时值 + provider 类型 + `ctx.web` 合并）、`dsh-credentials`、host-webserver、dsh-config-editor（`ctx.configEditor` 合并）由宿主提供；client half 的 `dsh.client.inject` 额外声明 `@deepseek-ai/dsh-api-remotes`（`ctx.remote.$on` 事件订阅，`document-updated` 已在 remotes 转发表注册）。

## 陷阱

- `web` 行必须显式点名本插件的 provider：base 默认是 `deepseek-official` / `http`，多个可用 provider 并存时 seam 对未配置选择直接报 `WEB_PROVIDER_AMBIGUOUS`，不会自动选中后注册者。
- `available()` 快照可能滞后（凭据在别处变更后、下一次状态读取前）：滞后 `true` 时失败由 `requireKey` 的 `WebError` 兜底，滞后 `false` 时 seam 报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`——两种都是清晰失败，不做后台轮询。
- `configEditor.edit` 的 change 里**不要整份展开 `inherited` 进 next**：会把部署默认值全量固化进用户层。关闭开关走 next=inherited 整行清除（官方「相等即清除」）；开启只叠加本插件的两个点名键。
- 智谱凭据是真实秘密：不入日志、不入版本库、不在面板展示明文。
- 用户此前经旧版本按钮写入的 `web-deepseek-api` 行指向已消亡的本地端点：开启开关会顺带清除；若清除被 home 层覆盖拒绝，报错原文透传面板，不静默放弃。

## 测试

`pnpm --filter @weilence/dsh-zhipu-tools test` 覆盖：provider 适配（搜索直通 query/signal 与结果、available 跟随快照、fetch 的 200+text 映射与失败上抛）、搜索与阅读核心的严格解析（嵌套与摊平形状、空白正文与未知形状报错、工具发现与取消、重定向拒绝）、面板路由集成（provider 注册与 dispose 注销、状态凭据三态与 enabled 三态（两键点名 / 官方值 / 混合态）、403、开关双向——开启次序（先清旧行再写 web 行）与凭据缺席 409、关闭触发整行清除并回退部署默认且不需要凭据、body 非布尔 400、web 行缺席 409、configEditor 拒绝时原文透传且 web 行不被触碰、信任边界 403/405）与 store / 投影（刷新、toggle 成功以响应视图为准且不弹提示、失败原文留开关旁且视图不变、pending 防抖、凭据徽标三态与故障透传）；用户凭据不用于自动化真实搜索。智谱 Coding Plan 对 DSH 的套餐适用性尚须由智谱确认。
