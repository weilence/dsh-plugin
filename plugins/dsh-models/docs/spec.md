# docs/spec.md——功能与行为规格

本文件承载 dsh-models 的功能与行为规格：插件定位、结构导览、路由与 wire 契约、目录与模型匹配、写入语义、用量适配与展示语义，文末「取舍」节记录已拍板的决策与理由。陷阱与防错理由见 [traps.md](traps.md)，测试地图见 [tests.md](tests.md)。

## 定位

- 设置页「模型目录」插件（settings.section id `dsh-models`）：浏览 models.dev，把 Provider / 模型写入宿主 `llm-pi-ai` 用户层，在面板上为每个模型设置能力（输入模态、上下文、输出上限）与推理强度（`reasoningEfforts`），生成内容严格遵循官方 `@deepseek-ai/dsh-llm-pi-ai` 配置格式。
- host 侧提供支持 ETag 的目录镜像、只读生效能力接口与订阅登录接口（openai-codex 等订阅型 Provider 的 OAuth 登录入口）。
- 本插件的 `cordis.patch.yml` 同时禁用官方 `ui-settings-models` 行，由本面板替代官方内置模型设置面板（name 守卫防错见 [traps.md](traps.md)）。
- 职责边界：host half 不解释 models.dev 业务字段——解析、筛选、协议映射、能力编辑、写入全在 client half。

## 结构导览（每文件一行）

- `src/index.ts`：host half 入口——catalog / effective-models / usage 路由与订阅登录接口挂接；effective 与登录接口为可选注册（明细见「路由与 wire 契约」）。
- `src/auth.ts`：订阅登录接口——`AuthAttemptRelay`（flow 交互 ↔ 事件缓冲中继，seq 跨尝试单调递增）+ 6 个 exact 路由（明细见「路由与 wire 契约」）。
- `src/mirror.ts`：models.dev 目录镜像——GET + If-None-Match、6 小时周期、退避重试、快照持久化到 `$DSH_HOME/cache/dsh-models/`。
- `src/effective.ts`：只读能力接口——`ctx.llm.resolveModelInfo` 的面板投影，与会话模型选择器同一事实源。
- `src/usage/`：`GET /dsh-models/usage?provider=` 的 Provider 分型用量查询（zhipu / codex / copilot 适配，语义见「用量适配与展示语义」）。
- `src/catalog/`：models.dev wire 解析与映射（parse / map / matching / types）。
- `src/pi-ai/`：纯逻辑层——route 状态判定与写入候选（profile / ops）、官方格式归一化与校验（normalize / validate）、schema 内省（choices / view）、类型（types）。
- `src/client/index.ts`：client half 入口，`index.ts` 接线、store / operations 状态层——本插件 client half 在 `src/client/` 目录而非 `src/client.tsx`（与[根 docs/architecture.md](../../../docs/architecture.md)「双 half 架构」的缺省形态不同）。
- `src/client/`（面板组件）：ModelCatalogSection 在 CardList 首行挂 CreateProviderForm——新建内置 / 自定义 Provider 并复用 ModelsDevImport；已配置 Provider 展开后由 RouteEditor / ModelForm 行内编辑（内置 / 自定义 route 同一套模型编辑：目录继承行编辑写 override，删除走整份展开）；连接字段（Endpoint / 协议）只在用户层写过 `api` / `baseURL` 时显示——模型编辑不改变连接继承形态；新增模型对 id 做 500ms 防抖的 models.dev 元数据自动填充（`lookupModelEntry` 同一条匹配链，合并语义与导入同构：只补空白 / 替换上次填充，手改字段不动）；带 oauth flow 的 Provider 由 ModelCatalogSection 统一渲染 SignInCard（`signInView(provider)` 返回 `{card, replacesApiKey}` 传给两个表单；store 轮询 700ms 折叠事件，attempt 状态由轮询循环持有）；CardList 与 ExpandableCard 来自 `@dsh-plugins/client-ui`；面板根经 `useWideSettingsDialog()`（同包）加宽宿主设置弹窗（机制见[根 docs/panel.md](../../../docs/panel.md)「面板交互约定」节）。
- `src/client/usage/`：会话输入框右侧的用量胶囊与详情，随当前 Provider 切换并按实际数据语义展示（展示语义见「用量适配与展示语义」）。
- `src/client/locales.ts`：本插件词典（命名空间 `dsh-models`）；两个 slot 注册（settings.section 面板与 conversation.input.right 用量胶囊）声明 `locale: NS`；`PanelMessage`（`{key, params}` 或 `{text}`）是 store / 校验层的消息描述子，渲染期经 `messageText` 取词——Host 原因用 text 原样展示，不翻译不吞。词典机制、`t` 标准 seat 合成、apply 域 `bind` 限制等通用约定见[根 docs/i18n.md](../../../docs/i18n.md)「多语言约定」节。

## 路由与 wire 契约

- `GET /dsh-models/catalog`：ETag 目录镜像（镜像行为见结构导览 `src/mirror.ts`）。
- `GET /dsh-models/effective-models`：只读生效能力接口，可选注册（`ctx.inject(['llm'])`——llm 服务不可用时不注册，目录接口照常）。
- `GET /dsh-models/usage?provider=`：Provider 分型用量查询（明细见「用量适配与展示语义」）。
- 订阅登录接口挂接为可选注册（`ctx.inject(['authorization'])`——authorization 服务未挂时接口不注册，面板静默隐藏登录特性，目录 / 生效接口不受影响）。
- 6 个 exact 路由：`GET /dsh-models/auth`（flow 目录 + grant 记录现状 + 进行中尝试）、`POST …/auth/begin`（预检 NO_FLOW / 404 / 409 后立即应答，异步结果走事件流）、`GET …/auth/events?after=`、`POST …/auth/answer`、`POST …/auth/cancel`、`POST …/auth/revoke`。
- `…/auth/revoke` 退出登录：`credentials.deleteRecord` 删 `llm-pi-ai` 记录；与进行中的登录互斥 409——删除撤不回 flow，它结束还会提交新记录。dispose 撤回仍在进行的尝试（悬空后果见 [traps.md](traps.md)）。
- 订阅登录凭据契约：凭据记录 scope 固定 `llm-pi-ai`（官方 `recordKeyFor` 的映射事实，与 settings namespace 同名）；订阅授权是凭据记录（`kind: 'grant'`），route 不写 `apiKeyEnv`，请求时由宿主凭存储的授权签发令牌；同一时刻接口只允许一个进行中的尝试；凭据记录变化经 `credentials/record-updated` 事件刷新「已授权」状态。
- API Key 契约：经 `credentials.set` 只写存储，`settings.yaml` 只记引用（`apiKeyEnv` 或派生 `<ROUTE>_API_KEY`）。
- `ProviderUsage` 失败分支：`{kind:'unavailable', provider, code, detail}`——`code` 为稳定原因码（`not_configured` / `not_signed_in` / `unsupported_account` / `authorization_changed` / `unknown`），client 按码翻译摘要；`detail` 是已脱敏的原始技术详情，与摘要并存展示，unknown 时 detail 即主文案。
- Host↔client 传语义不传文案：用量窗口标签是语义事实非文案（`UsageWindowLabel`）——通用约定见[根 docs/i18n.md](../../../docs/i18n.md)「多语言约定」节。

## 目录与模型匹配

- 面板行列表 = 已配置 route；未配置的内置 provider 只进「新建 Provider」下拉（背后实证见 [traps.md](traps.md)）。
- 「获取模型」：目录 route 不问 Endpoint，从 models.dev 拉该 Provider 的整份清单（`providerCatalogModels`，经别名表映射）补上 pi-ai 未收录的模型；自定义 route 仍走 Endpoint 询问。
- 匹配链的 provider 维度是精确比较 + 静态别名表（`ROUTE_PROVIDER_ALIASES`：pi-ai route id → models.dev provider id，如 `zai-coding-cn`→`zai-coding-plan`、`qwen-token-plan*`→`alibaba-token-plan*`；pi-ai 1.3.0 把 `azure-openai-responses` 改名 `azure` 与 models.dev 同名后别名已撤销）。
- `PREFERENCES`（模型前缀→厂商）：只收 models.dev 实际存在的 id；百度本体未收录，ernie 走全目录多数派；hunyuan 由 `tencent-coding-plan` 收录、mimo 指向 `xiaomi` 本体。
- 混协议目录 provider（`MIXED_PROTOCOL_PROVIDERS`：azure / cloudflare-ai-gateway / fireworks / github-copilot / opencode(-go) / openrouter）的目录外模型无法写入——RouteEditor 保存前经 `foreignModelsBlocked` 拦下并列出 id；「获取模型」照常添加目录外模型，由用户按提示删除（名单判据与成因见 [traps.md](traps.md)，取舍见「取舍」节）。
- 订阅型 Provider 判定：flow 带 `oauth` 方法（非「有 flow」）；oauth-only（`openai-codex` 等）登录卡替换 API Key 字段，双形态（`openrouter` 等）卡与 Key 字段并排（`SignInView.replacesApiKey`）；api-key 型 provider 的登录项在目录接口 host 侧就过滤掉（判定易错点见 [traps.md](traps.md)）。

## 写入语义

- 写入策略：一次改动 = 一个 `settings.mutate`，只 set / unset 目标 route 的子树并携带读取时 revision；`settings/conflict` 自动刷新后重试一次。只作用 `llm-pi-ai` 用户层，不重建组合 base、不碰 `llm-deepseek`（乐观并发等通用规则见[根 docs/panel.md](../../../docs/panel.md)「面板交互约定」节）。
- 字段映射（models.dev → llm-pi-ai）：`limit.context`→`contextWindow`、`limit.output`→`maxTokens`、`modalities.input` 的 text/image→`input`、`reasoning_options[effort].values`→`reasoningEfforts`（`none`/`off`→`off: null`）；价格 / 日期 / benchmark 只浏览不写入。
- 导入合并语义：已有用户字段优先，导入只补缺失。
- 单模型编辑写 `modelOverrides.<id>`（单模型定点覆盖，与 `models` 互斥）；新增目录未描述的模型、删除目录内模型都触发整份 `models` 展开为显式清单（UI 先警告，草稿进入显式态后提示常驻）；编辑结果与目录默认等价时删除该 override；目录外的 override 条目（历史遗留）删除只删条目本身。
- `reasoningEfforts` 的六条官方规则在 client 保存前逐条前置校验（与 host half 双侧同步的要求见 [traps.md](traps.md)）。
- 协议、推理强度、`thinkingFormat` 与模态选项从 `llm-pi-ai` namespace 的 schema envelope 内省，schema 不可读时回退内置常量（FALLBACK_CHOICES）。
- ModelForm 的继承字段（`contextWindow` / `maxTokens` / `compat`）统一接共享 kit 的覆盖交互（`override`）：空 = 继承目录 / route 默认（placeholder 显示默认），非空即「已覆盖」；重置只把草稿清回空（继承态），写入仍由外层保存完成；字段校验错误经 `error` 走统一非法态——官方 SettingsValueField 契约见[根 docs/panel.md](../../../docs/panel.md)「面板交互约定」节。

## 用量适配与展示语义

- 适配分型：智谱配额由 Host 缓存；Codex 直接读取 ChatGPT 限额；Copilot 复用模型登录的 GitHub OAuth 凭据查询私有套餐额度接口。
- 智谱：读取 Host 凭据 `ZAI_CODING_CN_API_KEY`，未配置时尝试 `ZAI_API_KEY`；用量查询独立于 dsh-zhipu-tools 的 MCP 挂载。
- Codex：直连第一方未公开的 `/backend-api/wham/usage`（不是有兼容承诺的第三方接口）；Host 在 `credentials.modifyRecord` 锁内解析 `llm-pi-ai/openai-codex` grant、复用 pi-ai OAuth 刷新，从同一快照取得令牌与账户 ID，复用模型面板中 `openai-codex` 的订阅登录——不需要安装或登录 Codex CLI；查询地址来自 Codex 开源实现（[调研](../../../docs/research/codex-direct-usage.md)），后端地址或响应格式变化时面板明确报告错误（权宜取舍与移除条件见「取舍」节）。
- Copilot：从 `llm-pi-ai/github-copilot` grant 读取 GitHub OAuth token（`refresh` 字段，不是模型请求用的 Copilot access token），向固定 `api.github.com/copilot_internal/user` 请求，读取 `quota_snapshots.premium_interactions` 的剩余比例、额度和重置时间；无需配置 `COPILOT_BILLING_TOKEN`，无需安装 Copilot CLI 或 SDK；仅支持 `github.com` 登录；该额度不是会话／每周限额，也不得视为可计费余额（[调研](../../../docs/research/copilot-quota-implementations.md)）。
- 只向浏览器返回展示数据，不下发凭据（窗口标签是语义事实非文案，见「路由与 wire 契约」）。
- 轮询与缓存：三种用量仅在当前会话选择对应 Provider 时轮询；Host 缓存正常结果约 4 分钟，短暂缓存失败结果；详情面板可手动刷新。
- 展示语义：全部展示文案跟随宿主语言——语言环境取 `ctx.locale` 服务面（client `inject` 声明 `'locale'`，`dsh.client.inject` 注入 `@deepseek-ai/dsh-client-locale`）；中文重置时间用 dayjs 实例 locale（`zh`→`zh-cn`）渲染，其余语言用紧凑时长（`resets in 3h`）保证窄列不截断；展开态不使用 Pill 的 active 填充，与官方模型选择触发器一致；用量请求与语言解耦——切换语言只重渲染，不重新查询。

## 取舍

- 拍板决策：混协议目录 provider 的目录外模型无法写入，定位为上游声明面缺口，只报告、不改宿主——pi-ai 运行层本就按 `model.api` 逐模型分发，缺口只在声明面（实证见 [traps.md](traps.md)，拦截行为见「目录与模型匹配」）。
- 拍板决策：Codex 用量直连 `/backend-api/wham/usage` 是权宜方案——当前 DSH 没有由 `llm-pi-ai` 提供的只读用量接口，因此 Host 暂时解析 `llm-pi-ai/openai-codex` grant、复用 pi-ai OAuth 刷新（机制见「用量适配与展示语义」），接受耦合该插件的私有凭据格式；后续若宿主提供所属插件侧的用量接口，应优先移除这段跨插件解释。
