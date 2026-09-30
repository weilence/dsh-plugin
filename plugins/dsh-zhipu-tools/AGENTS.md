# @weilence/dsh-zhipu-tools

智谱搜索替换开关 + MCP 工具集：设置页开关式把官方 `web_search` 的搜索后端切为智谱（**默认不替换**，写入两层用户 patch），同时挂载 zhipu_search / zhipu_reader 两台 MCP 服务器。用量展示归 `dsh-models`。

## 结构与约定

- `src/search.ts`：`WebSearchProvider` 实现。每次搜索解析凭据、经 SDK 建立短连接、检查远端工具名称及 `search_query` schema、严格解析来源并关闭连接；请求禁止跟随携带 Bearer 的重定向。智谱未公布稳定输出结构，变化须明确报错，不能将解析失败当成零结果。插件注册该 provider 但默认不选中——官方组合显式 `deepseek-official` 下它是惰性的，开启开关后无需重载插件即接管。
- `src/switchPatch.ts`：web 覆盖行的文档级编辑原语。开启就地只改 `searchProvider` 一个键（原值记进行注释 `dsh-zhipu-tools previous:`，其他键与用户注释原样保留）；两层都没有 web 行时在 home 新建托管行（`dsh-zhipu-tools managed` 标记，config 以运行时生效配置为底整体替换——漏 `fetchProvider` 会打掉官方抓取）。关闭按来历处置：managed 行整行删除（行含条目级以外的键时保守降级为改回官方默认）、previous 行恢复原值（`none` = 删键）、手写智谱行改回 `deepseek-official`。只动「当前值是 zhipu」的行。
- `src/live.ts` + `src/index.ts` 开关路由：读态以 Loader 内省的运行时生效值为准（不可用时降级两层文件折叠）。来源判定注意：宿主把所有层（bundle patch、用户层、`--patch`）摊平进同一个根 include 树（app-boot 单一 bootstrap include），**树形结构区分不出 CLI 来源**——判定规则为：文件有同 id 行 = file（就地改）；include 子树或进程无 `--patch` = bundle（home 覆盖）；摊平 + 无文件行 + 进程带 `--patch` = cli（置灰）；无条目或行被停用 = 置灰说明。`--patch` 在场但文件已有行的组合按 file 处理，真被覆盖由写入后的运行时比对暴露。写入走两层用户 patch（见根「两层用户 patch 约定」）；无 HMR 的宿主面板提示重启。
- `src/shared.ts`：双端 wire 类型；`src/client/`：设置面板（Switch + 状态元信息 + 等待生效/被覆盖/需重启提示），`projectSwitch` 纯投影可单测（签名 `projectSwitch(t, view, pending, busy)`，文案经 `t` 取词、Host reason 原样透传）。`src/client/locales.ts`：本插件词典（命名空间 `dsh-zhipu-tools`，zh 为键集事实源、en 编译期查全），client `apply` 经 `ctx.locale.register` 注册、`ctx.locale.bind` 绑定，导航 label 是 thunk、store 的即显 notice 在事件时间取词；单测取词用 `test/i18n.ts` 的 `makeT`。
- `src/index.ts` MCP 挂载：搜索 MCP 向模型暴露 `search_query` 之外的域过滤、时效等参数，与 provider 互不替代；Reader 没有 `web_fetch` 所需的真实状态码等事实，不能冒充抓取提供者。凭据仅在 `ZAI_CODING_CN_API_KEY` 缺席时尝试 `ZAI_API_KEY`，解析故障直接报错。
- 依赖：`@modelcontextprotocol/client` 是运行时直接依赖；`yaml` 与 `@deepseek-ai/cordis-plugin-loader`（live.ts 判定 bundle 子树）经 host.bundle 内联；`@deepseek-ai/dsh-web`、`dsh-mcp-client` 由宿主提供；通用 patch 原语来自 `@dsh-plugins/shared/patch`。

## 陷阱

- `web.searchProvider` 是启动期组合配置（bundle→profile→home→CLI 整体替换、后层覆盖前层），运行期不可动态修改——这是开关走 patch 文件而非运行时状态的原因。
- 卸载插件前先关闭替换，否则残留的 patch 行会让 `web_search` 报 `WEB_PROVIDER_CONFIGURED_MISSING`；面板在开启态常驻提示。
- 新建托管行必须以生效配置为底，不能只写 searchProvider。
- 非 profile 启动的宿主无 `profileContext`，开关路由 503、面板置灰给原因。

## 测试

`pnpm --filter @weilence/dsh-zhipu-tools test` 覆盖严格搜索解析、重定向拒绝、patch 原语（就地改/恢复/删除/标记/保守降级）、两路由集成（来源判定、开/关/幂等/503/409/403/解析失败）、store 与投影（等待态结算、降级提示）；用户凭据不用于自动化真实搜索。「覆盖 base 行的 HMR 热载」机制已源码确认但无先例，真机验证前面板以运行时实际值兜底展示。智谱 Coding Plan 对 DSH 的套餐适用性尚须由智谱确认。
