# @weilence/dsh-models

设置页「模型目录」插件：浏览 models.dev、把 Provider / 模型写入宿主 `llm-pi-ai` 用户层；host 侧提供支持 ETag 的目录镜像、只读生效能力接口与订阅登录接口（openai-codex 等订阅型 Provider 的 OAuth 登录入口）。

## 结构

- `src/index.ts`：host half——`GET /dsh-models/catalog`（ETag 镜像）、`GET /dsh-models/effective-models`（可选注册，`ctx.inject(['llm'])`：llm 服务不可用时不注册，目录接口照常）与订阅登录接口挂接（可选注册，`ctx.inject(['authorization'])`）。
- `src/auth.ts`：订阅登录接口——`AuthAttemptRelay`（flow 交互 ↔ 事件缓冲中继，seq 跨尝试单调递增）+ 6 个 exact 路由：`GET /dsh-models/auth`（flow 目录 + grant 记录现状 + 进行中尝试）、`POST …/auth/begin`（预检 NO_FLOW / 404 / 409 后立即应答，异步结果走事件流）、`GET …/auth/events?after=`、`POST …/auth/answer`、`POST …/auth/cancel`、`POST …/auth/revoke`（退出登录：`credentials.deleteRecord` 删 `llm-pi-ai` 记录；与进行中的登录互斥 409——删除撤不回 flow，它结束还会提交新记录）。dispose 撤回仍在进行的尝试——悬空的 interaction 会让 flow 持有的 key 挂起直到进程结束。
- `src/mirror.ts`：models.dev 目录镜像（GET + If-None-Match、6 小时周期、退避重试、快照持久化到 `$DSH_HOME/cache/dsh-models/`）。
- `src/effective.ts`：只读能力接口（`ctx.llm.resolveModelInfo` 的面板投影，与会话模型选择器同一事实源）。
- `src/usage/`：`GET /dsh-models/usage?provider=` 的 Provider 分型用量查询；智谱配额由 Host 缓存，Codex 直接读取 ChatGPT 限额，Copilot 复用模型登录的 GitHub OAuth 凭据查询私有套餐额度接口。只向浏览器返回展示数据（窗口标签是语义事实非文案，`UsageWindowLabel`），不下发凭据。
- `src/catalog/`：models.dev wire 解析与映射（parse / map / matching / types）。
- `src/pi-ai/`：纯逻辑层——route 状态判定与写入候选（profile / ops）、官方格式归一化与校验（normalize / validate）、schema 内省（choices / view）、类型（types）。
- `src/client/usage/`：会话输入框右侧的用量胶囊与详情，随当前 Provider 切换并按实际数据语义展示；全部展示文案跟随宿主语言——语言环境取 `ctx.locale` 服务面（client `inject` 声明 `'locale'`，`dsh.client.inject` 注入 `@deepseek-ai/dsh-client-locale`），词典在 `locales.ts`（zh/en，其余回退 en）；中文重置时间用 dayjs 实例 locale（`zh`→`zh-cn`）渲染，其余语言用紧凑时长（`resets in 3h`）保证窄列不截断。展开态不使用 Pill 的 active 填充，与官方模型选择触发器一致。
- `src/client/`：面板——`index.ts` 接线、store / operations 状态层；ModelCatalogSection 在 CardList 首行挂 CreateProviderForm，新建内置 / 自定义 Provider 并复用 ModelsDevImport；已配置 Provider 展开后由 RouteEditor / ModelForm 行内编辑（内置 / 自定义 route 同一套模型编辑：目录继承行编辑写 override，删除走整份展开）。连接字段（Endpoint / 协议）只在用户层写过 `api` / `baseURL` 时显示——模型编辑不改变连接继承形态。新增模型对 id 做 500ms 防抖的 models.dev 元数据自动填充（`lookupModelEntry` 同一条匹配链，合并语义与导入同构：只补空白 / 替换上次填充，手改字段不动）。带 oauth flow 的 Provider 由 ModelCatalogSection 统一渲染 SignInCard（`signInView(provider)` 返回 `{ card, replacesApiKey }` 传给两个表单；store 轮询 700ms 折叠事件，attempt 状态由轮询循环持有）。CardList 与 ExpandableCard 来自 `@dsh-plugins/client-ui`。面板根经 `useWideSettingsDialog()`（同包）加宽宿主设置弹窗。

## 改动约定

- host half 不解释 models.dev 业务字段：解析、筛选、协议映射、能力编辑、写入全在 client half。
- 写入策略：一次改动 = 一个 `settings.mutate`，只 set / unset 目标 route 的子树并携带读取时 revision；`settings/conflict` 自动刷新后重试一次。只作用 `llm-pi-ai` 用户层，不重建组合 base、不碰 `llm-deepseek`。
- 单模型编辑写 `modelOverrides.<id>`（单模型定点覆盖，与 `models` 互斥）；新增目录未描述的模型、删除目录内模型都触发整份 `models` 展开为显式清单（UI 先警告，草稿进入显式态后提示常驻）；编辑结果与目录默认等价时删除该 override；目录外的 override 条目（历史遗留）删除只删条目本身。
- 字段映射（models.dev → llm-pi-ai）：`limit.context`→`contextWindow`、`limit.output`→`maxTokens`、`modalities.input` 的 text/image→`input`、`reasoning_options[effort].values`→`reasoningEfforts`（`none`/`off`→`off: null`）；价格 / 日期 / benchmark 只浏览不写入。导入合并语义：已有用户字段优先，导入只补缺失。
- `reasoningEfforts` 的六条官方规则在 client 保存前逐条前置校验，与 host half 的 `resolveModelReasoning()` 一一对应——改一侧必须同步另一侧。
- 协议、推理强度、`thinkingFormat` 与模态选项从 `llm-pi-ai` namespace 的 schema envelope 内省，schema 不可读时回退内置常量（FALLBACK_CHOICES）。
- 订阅登录：凭据记录 scope 固定 `llm-pi-ai`（官方 `recordKeyFor` 的映射事实，与 settings namespace 同名）；decline 必须用官方 `AuthorizationDeclinedError`（seam 靠它把「人拒绝」判定为 cancelled），prompt 自带 signal 的撤回必须以普通 Error 拒绝；**空字符串是合法应答**（prompt 契约没有必填标记，copilot flow 的「Enterprise URL，空 = github.com」靠空提交推进，卡片提交按钮不得因空输入禁用）；同一时刻接口只允许一个进行中的尝试，凭据记录变化经 `credentials/record-updated` 事件刷新「已授权」状态。

## 陷阱

- 官方 `llm-pi-ai` 会把全部内置 provider 声明进可配置目录，但真正注册的 route 只有配置里存在的：面板行列表 = 已配置 route；未配置的内置 provider 只进「新建 Provider」下拉。
- 官方 `discoverModels` 对带 `provider` 且安装目录有模型的 route **直接以注册表回答、不访问 endpoint**，且安装目录随 pi-ai 包发布、滞后于 models.dev：目录 route 的「获取模型」因此不问 Endpoint，改从 models.dev 拉该 Provider 的整份清单（`providerCatalogModels`，经别名表映射）补上 pi-ai 未收录的模型；自定义 route 仍走 Endpoint 询问。
- 匹配链的 provider 维度是**精确比较 + 静态别名表**（`ROUTE_PROVIDER_ALIASES`：pi-ai route id → models.dev provider id，如 `zai-coding-cn`→`zai-coding-plan`、`qwen-token-plan*`→`alibaba-token-plan*`），不用 normalize 之类的模糊归一。别名表与 `PREFERENCES`（模型前缀→厂商，只收 models.dev 实际存在的 id；百度 / 腾讯本体未收录，ernie / hunyuan 走全目录多数派）都是**快照事实**（pi-ai 0.85.1 ↔ models.dev 2026-09）——升级任一侧须复核两张表；models.dev 改名只会让匹配静默降级到 ②③ 层，不报错。
- 混协议目录 provider（`MIXED_PROTOCOL_PROVIDERS`：cloudflare-ai-gateway / fireworks / github-copilot / opencode(-go) / openrouter，pi-ai 0.85.1 快照，复核方法见 types.ts 表注释）的目录外模型**无法写入**——官方配置面没有模型级 `api`，route 级 `api` 会覆盖全部目录模型，目录共用协议又不存在。pi-ai 运行层本就按 `model.api` 逐模型分发，缺口只在声明面（上游需求，只报告不改宿主）。RouteEditor 保存前经 `foreignModelsBlocked` 拦下并列出 id；「获取模型」照常添加目录外模型，由用户按提示删除。
- 本插件的 `cordis.patch.yml` 同时禁用官方 `ui-settings-models` 行（name 守卫：id 不再指向官方包时跳过并告警，避免误禁其他行）。
- API Key 经 `credentials.set` 只写存储，`settings.yaml` 只记引用（`apiKeyEnv` 或派生 `<ROUTE>_API_KEY`）；面板不读取、不缓存、不回显。
- 订阅型 Provider 的判定是 **flow 带 `oauth` 方法**，不是「有 flow」：宿主为每个 pi-ai provider 都注册登录（api-key 型的「登录」只是交互式问密钥，面板的 API Key 字段已是其等价物），目录接口在 host 侧就过滤掉它们。oauth-only（`openai-codex` 等）登录卡替换 API Key 字段；双形态（`openrouter` 等，oauth + api-key 方法并存）卡与 Key 字段并排（`SignInView.replacesApiKey`）。
- 官方 GUI 没有任何触发 `ctx.authorization` 登录流的入口——订阅登录全靠本接口驱动；接口不可用（authorization 服务未挂）时面板静默隐藏登录特性，目录 / 生效接口不受影响。
- Copilot 套餐额度从 `llm-pi-ai/github-copilot` grant 读取 GitHub OAuth token（`refresh` 字段），不是模型请求用的 Copilot access token；向固定 `api.github.com/copilot_internal/user` 请求。企业域名不能默认为 github.com，必须明确不支持；未公开接口响应变化时禁止退回账单数据或猜额度。
- Codex 用量直连第一方未公开的 `/backend-api/wham/usage`，不是有兼容承诺的第三方接口。当前 DSH 没有由 `llm-pi-ai` 提供的只读用量接口，因此 Host 暂时在 `credentials.modifyRecord` 锁内解析 `llm-pi-ai/openai-codex` grant，复用 pi-ai OAuth 刷新，并从同一快照取得令牌与账户 ID；这会耦合该插件的私有凭据格式。后续若宿主提供所属插件侧的用量接口，应优先移除这段跨插件解释。不能将原始 grant 或令牌传给浏览器。

## 测试

`pnpm --filter @weilence/dsh-models test`：mirror（退避 / ETag / 持久化）、catalog 与 pi-ai 纯函数、effective / auth / usage Host 路由测试、store（含登录轮询生命周期）/ operations / panel / view / SignInCard，以及各 Provider 用量适配器与展示语义测试。
