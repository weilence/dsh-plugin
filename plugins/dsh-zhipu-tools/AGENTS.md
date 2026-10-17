# @weilence/dsh-zhipu-tools

智谱搜索本地端点 + MCP 工具集：host half 在 loopback 起 DeepSeek Web Tools API 兼容端点（`/search` 承接智谱联网搜索、`/fetch` 承接智谱网页阅读），用户把内置 Web 搜索设置的「Search / Fetch API base URL」与密钥栏分别填端点地址与面板展示的 API 密钥——**不替换内置搜索插件**；同时挂载 zhipu_search / zhipu_reader 两台 MCP 服务器。用量展示归 `dsh-models`。

## 结构与约定

- `src/endpoint.ts`：协议与生命周期。wire 协议对齐 `@deepseek-ai/dsh-web-deepseek-api`（宿主 0.2.1 起）：`POST {base}/search` 请求 `{query, count, need_content, ori_question?}`、响应 `{results:[{url,title,snippet,date}]}`（`date` 必须在场，`undefined` 会被官方解析器判无效）；`POST {base}/fetch` 请求 `{url}`、响应 `{content}`。鉴权走 `Authorization: Bearer <token>`——token 即面板展示、填进内置密钥栏的 API 密钥（一石二鸟：过内置提供方「凭据在场」的派发前检查 + 端点自身鉴权），URL 不携带秘密。`createEndpointRouter` 是纯请求处理（假 req/res 可测），`startEndpointServer` 负责监听：状态文件 `$DSH_HOME/dsh-zhipu-tools.json` 持久化 `{port, token}`（tmp+mv 原子写），默认端口被占时回退系统分配并回写——地址以面板实时展示为准；文件损坏时明确报错，绝不静默重置 token。信任边界：仅绑 `127.0.0.1` + loopback Host 头 + 非跨站标记（`shared/http`）+ Bearer 令牌 timing-safe 比对（缺失与错误同形 401）。调用方断开经 `res 'close'` + `writableFinished` 判定后中止上游——**不要挂 `req 'close'`**，请求体读完后它就会触发。
- `src/search.ts`：智谱搜索核心（可调用函数，不再是 WebSearchProvider）。每次搜索解析凭据、经 SDK 建立短连接、检查远端工具名称及 `search_query` schema、严格解析来源并关闭连接；请求禁止跟随携带 Bearer 的重定向。智谱未公布稳定输出结构，变化须明确报错，不能将解析失败当成零结果。`count` 只用于截断已收到的来源（智谱侧无对应入参），`need_content` / `ori_question` 是官方 Messages 侧概念，忽略。
- `src/reader.ts`：智谱网页阅读核心（webReader MCP），结构镜像 search.ts（短连接、工具发现 + `url` schema 检查、`redirect: 'error'`、严格解析）。取正文的候选形状按序：单文本块 JSON（可双层编码）里的 `content` / `reader_result.content`（HTTP 契约嵌套层）→ 非 JSON 单文本块本身（MCP 可能直接回 Markdown）→ structuredContent；**空白正文与无正文字段的形状明确报错**，对齐官方 Fetch API「目标无可用内容即失败」的语义——不把提取失败伪装成空页。超时 60s（reader 侧页面抓取比搜索慢）。
- 官方 Fetch 与智谱 reader 的等价性依据：两边输出同为「解析提取后的 Markdown 正文」，且都不报目标页状态码 / 最终 URL（官方 provider 本就把成功映射为 200）；差异只在提取力度与契约稳定性（MCP 无公开 schema，靠严格解析兜底）。`/fetch` 不做「reader 失败回退官方」的静默回退。
- `src/index.ts`：apply 装配。搜索与阅读共用 `requireKey`（同一把智谱凭据、同一套失败语义）。端点启动失败不拖垮插件（MCP 与状态路由照常），原因原样进面板；MCP 挂载结果记入状态视图。状态路由 `GET /dsh-zhipu-tools/endpoint` 每次现查凭据（补配后无需重启即反映）。凭据仅在 `ZAI_CODING_CN_API_KEY` 缺席时尝试 `ZAI_API_KEY`，解析故障直接报错。
- `src/shared.ts`：双端 wire 类型与常量（`KEY_REFS` 单一事实源、`fetchBackend: 'zhipu-reader'`、`token` 即面板 API 密钥）；`src/client/`：设置面板（端点地址与 API 密钥均可选中复制 + 接入步骤四步 + 监听 / 凭据 / MCP / 抓取后端元信息，Host 失败原文原样透传），`projectEndpoint` 纯投影可单测（签名 `projectEndpoint(t, view)`）。`src/client/locales.ts`：本插件词典（命名空间 `dsh-zhipu-tools`，zh 为键集事实源、en 编译期查全），client `apply` 经 `ctx.locale.register` 注册、`ctx.locale.bind` 绑定，store 的即显 notice 在事件时间取词；单测取词用 `test/i18n.ts` 的 `makeT`。
- 依赖：`@modelcontextprotocol/client` 是运行时直接依赖；`yaml` 经 host.bundle 内联（端点状态文件原子写来自 `@dsh-plugins/shared/patch`，该模块顶层依赖 yaml）；`@deepseek-ai/dsh-home-paths`、`dsh-web`、`dsh-mcp-client`、host-webserver 由宿主提供。

## 陷阱

- 为什么不用 `ctx.webServer` 挂端点路由：desktop 宿主以 `--port 0` 启动（每次随机端口）且 URL 带鉴权，填进设置的地址活不过一次重启；自有 loopback 服务 + 持久化端口/token 才是可填一次的稳定地址。相对路径也不可行：内置提供方 `available()` 的 `URL.canParse` 与 Node fetch 都只认绝对 URL。
- 内置提供方派发前要求凭据在场（`resolveApiKey` 无果即抛 `WEB_PROVIDER_CREDENTIAL_MISSING`）——本插件的解法是把端点访问令牌同时作为 API 密钥让用户填进密钥栏，无需 DeepSeek 账号或真实 Key。**该方案对所有会话生效**：宿主账号服务的 `resolveToken` 按目标 origin 白名单只向 DeepSeek 推理源发放账号令牌，端点在 `127.0.0.1` 上恒得 `undefined`，账号模型的会话同样回落到 API Key 路径（源码已核实：`deepseek-account-platform/src/index.ts`）。
- 官方解析器对 `/search` 响应逐字段校验：`date` 缺席（`undefined`）即整包判无效，必须显式 `null` 或字符串。
- URL 不含秘密后，内置提供方错误信息回显端点地址已无泄漏面；但 API 密钥仍是端点访问令牌，不入日志、不入版本库。
- 卸载插件前须引导用户把内置设置里的 base URL 改回，否则 `web_search` 指向已消亡的端点。

## 测试

`pnpm --filter @weilence/dsh-zhipu-tools test` 覆盖：协议形状（date 在场、count 截断、publishedAt 透传、`/fetch` 的 `{content}` 映射）、信任边界（Host / 跨站 / 方法 403/405、Bearer 缺失与错误同形 401、旧版 `/t/<token>` 路径 404 回归）、reader 严格解析（嵌套与摊平形状、空白正文与未知形状报错、工具发现与取消）、监听生命周期（状态持久化、重启地址不变、端口自愈、损坏状态文件明确报错；含真实回环往返与真实 401/405）、状态路由集成（凭据在场 / 缺席 / 解析故障、端点失败不牵连 MCP、403）与 store / 投影（刷新、地址与密钥复制提示、状态文案）；用户凭据不用于自动化真实搜索。智谱 Coding Plan 对 DSH 的套餐适用性尚须由智谱确认。
