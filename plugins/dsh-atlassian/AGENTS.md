# @weilence/dsh-atlassian

Atlassian 集成插件：host half 直连 Jira / Confluence REST（Cloud + Server/DC 双形态），注册四个只读模型工具与 `/jira`、`/conf` 命令；client half 提供站点设置面板与 `tool.call.toolview` 工具卡片。M1 范围只读；写操作（评论 + 状态流转）、@ 候选、主面板工作台、事件自动化是后续里程碑，未实现。

## 结构

- `src/index.ts`：apply 装配。`inject: ['credentials', 'tools', 'commands', 'webServer', 'configEditor']`（五项都是核心依赖，缺席即整行不激活）。先 `sites.refresh()` 建快照，再注册工具（`when` 同步读快照）、命令与六条面板路由（sites / cwd 桥 / save / delete / clear-token / test，写操作响应即最新视图，客户端不二次拉取；sites GET 的 `?cwd=` 与 cwd POST 桥都是工作区关联的 cwd 来源，dsh-mcp 同模式）。
- `src/shared.ts`：双端 wire 类型与常量（路由路径、`SiteDraft` 按 kind 分形的字段——cloud 用 `atlassianUrl` / `atlassianTokenRef` 且两产品共用，server 用 `jiraUrl` + `confluenceUrl` / `jiraTokenRef` + `confluenceTokenRef`、校验拒绝交叉字段、server 缺 confluenceUrl 即非法——以及 `ProductSite` 归一连接视图与 `jiraProductOf` / `confluenceProductOf` 归一函数）。
- `src/sites.ts`：站点注册表。站点元数据存本插件行 config（`configEditor.configuration()` 现读——profile 覆盖非空以覆盖为准，与官方卡片同口径；写入走 `ctx.configEditor.edit`，文件锁 / schema 路径 / 原子写官方保障）；token 走 `ctx.credentials`（`resolve` 每次操作现解析，`describe` 只报 configured / source 不回显，存储值优先环境变量兜底）。`normalizeSites` 把非法行降级为 problems 不炸整表；`chooseSite`（纯函数）实现选站顺序：显式 site → 当前工作区（`workspaces` 目录唯一命中主视图 cwd）→ hint（工单号 / JQL / CQL）按 `projects` 键词边界唯一命中 → 默认站点 → 唯一站点 → 报错列名；cwd 由 client 上报、`setWorkspaceCwd` 存档（Windows 比较忽略大小写），`requireSite` 现读后委托 chooseSite。
- `src/rest.ts`：两个 client 共用的 REST 封装——入参是 `ProductSite`（base = `url`）、认证头（cloud Basic / server Bearer）、30s 软超时（调用方取消原样抛 AbortError，宿主管道按其落 ABORTED 结果）、HTTP 状态 → 面向模型的明确失败（401/403 凭据、404 未找到、429 速率受限，detail 取响应 errorMessages）。
- `src/jira.ts` / `src/confluence.ts`：产品 client，入参 `ProductSite`（地址已按 kind 归一：cloud 两产品同为 atlassianUrl，server 分别为 jiraUrl / confluenceUrl）。cloud 与 server 的端点差异收在各自文件顶部（Jira：cloud POST `/rest/api/3/search/jql`、server GET `/rest/api/2/search`；Confluence：统一 v1，仅 cloud 带 `/wiki` 前缀）；`fetchImpl` 参数可注入供单测替换。
- `src/markup.ts`：正文转换层——ADF → markdown（块级遍历，未知节点回退文本提取）、storage XHTML → markdown（顺序替换 + CDATA 解包 + 嵌套列表摊平，复杂宏降级）、Jira wiki markup → markdown（轻转换）、字符级截断。
- `src/tools.ts`：`defineTool` × 4。output schema 用宿主统一 DSL（object 必须显式 `additionalProperties`）；产物经一次 JSON 往返剔除 undefined（lossless JSON 要求）；`presentationMeta` 投影卡片事实（kind 判别：jira-issue / jira-search / confluence-search / confluence-page），持久化在 tool/result 上供卡片回放读取。
- `src/commands.ts`：命令语法与装配。`parseJiraLine`（首段匹配工单号形态 → issue，否则整行 free）、`parseConfLine`；命令**不带站点参数**——站点一律由配置自动关联（工作区 / 项目键，见 sites.ts）。steer 文本模板面向模型（约定工具用法 + 多文档读取要求 + 引用清单格式）；handler 校验失败返回 error 文本，成功 `agent.steer(createUserMessage(...))` 后返回 success 摘要。
- `src/client.tsx`：client apply。settings.section（order 42）+ 四个 `tool.call.toolview` keyed 注册；`inject` 声明含 `sessions`——订阅官方 `sessions.list` 快照，把主视图会话 cwd（`retainedBy.mainView > 0`）经 `/dsh-atlassian/cwd` 上报 host 并同步进 store（工作区关联事实源；上报失败静默，list 请求携带 cwd 兜底，dsh-mcp 同模式）。
- `src/client/`：`locales.ts`（NS `dsh-atlassian`，zh 键集事实源）、`api.ts`（bridge client，自定义头 `x-dsh-atlassian`）、`store.ts`（useSyncExternalStore 三件套；store 只持事实，文案由组件在事件时间取词后 `setNotice` 送入）、`SitesSection.tsx`（站点卡片 + 行内表单 + 测试结果 + ConfirmDialog + Toast）、`tool-cards.tsx`（四张卡片：meta 驱动、检索卡命中结果全量展开、展开区显示模型渲染原文）。

## 生效链路

- 站点写路由 → `configEditor.edit` → Loader 走普通更新路径 → 本插件 fiber 重挂 → 工具 / 命令 / 路由 / 快照整体重建。没有 HMR 依赖，也没有重启需求。
- 工具 `when` 同步读快照（`usableCount`）：没有任何站点配置好凭据时四个工具整体不进模型面；快照在 apply 与每次写路由后刷新（fiber 重挂保证新鲜）。
- 工具与命令每次执行现读站点配置、现解析凭据——轮换 token 即时生效，不做进程内缓存。

## 改动约定

- 工具面只读；新增工具必须同步定义 output schema、render、presentationMeta 与卡片（kind 判别 + client 守卫），四件套缺一卡片就静默回落通用卡。
- 多文档展示是定稿需求：检索类卡片的命中结果全量逐行展示（行行带链接），steer 文本里「不要只看第一篇 / 末尾附清单」的措辞是产品约定，改动需回到方案层。
- 卡片零固定文案：标题与列表全部来自 meta 数据（历史回放可用），失败态红点 + 错误原文；加文案需引入 locale seat 并同步 zh / en。
- 命令 handler 禁止网络调用——它是人类直达通道，不是模型代理。

## 陷阱

- **InjectFace 是扁平合入 props 的**：`const { store, t } = props`，不存在 `props.inject`。
- 宿主统一 schema DSL 的 object 节点**必须显式 `additionalProperties`**；`required` 是每个属性上的注解，不是顶层数组；产物类型由 schema 推断，execute 返回 `JSON.parse(JSON.stringify(x))` 的 any 恰好对齐推断与 JsonValue 双重要求。
- `agent.steer(createUserMessage({ content, source: { kind: 'user' } }))` 是命令提交模型的唯一通道（`dsh-plan-mode` 先例）；`agent.inject` 不唤醒 agent。
- Jira Cloud 搜索新端点不保证返回 `total`——截断判定在 total 缺席时改看 `nextPageToken`；评论走独立端点取一页再截尾部，避免热工单整页拖垮。
- Confluence 检索必须 v1（`/rest/api/search`，cloud 带 `/wiki`）；storage 正文里的 CDATA 被 `<[^>]+>` 剥标签正则吞掉，stripTags 前必须先解包。
- rest 软超时与调用方取消合流时，取消要原样抛 AbortError——包成 HttpError 会破坏宿主管道的 ABORTED 语义。
- 多站点未指明且工作区与项目键都未唯一命中且无默认站点时报错列站点名是定稿行为（fail explicitly），不要改成猜第一个；`projects` 键的 hint 匹配用词边界正则（`\bABC\b`，大小写不敏感），只有唯一命中才自动选站，歧义一律回落默认/报错。
- 工作区关联的 cwd 依赖 Web 客户端上报（宿主刚启动、客户端未连时 cwd 未定，工作区匹配自动跳过，回落项目键 / 默认站点）——与 dsh-mcp 工作区档同前提，勿改成猜进程 cwd；Windows 路径比较忽略大小写，其余平台保留。
- Server / DC 的 Jira 与 Confluence 是两个独立应用：地址（`jiraUrl` / `confluenceUrl`）与凭据（`jiraTokenRef` / `confluenceTokenRef`）都按产品显式分离，校验强制互斥（cloud 带 server 字段、server 带 cloud 字段、server 缺 confluenceUrl 均直接拒绝）；client 入参是 `ProductSite`（地址已归一），「测试连接」与工具走同一 client 构造，别在路由里单独拼 URL。Cloud 一份 `atlassianUrl` + 一份 token（两产品共用），不借用任何 Jira 字段命名。
- devDependencies 的 `@deepseek-ai/*` 平台包即使有运行时值导入（`defineTool` / `createUserMessage`）也只声明在 devDependencies——宿主运行期供给，与 dsh-zhipu-tools 的 `dsh-web` 同例。

## 测试

`pnpm --filter @weilence/dsh-atlassian test`（单测，110 例）：markup 转换与截断、命令语法与 steer 文本、sites 凭据引用派生（cloud / server 两套）、按 kind 分形的草稿校验（交叉字段拒绝）与 `chooseSite` 选站顺序（工作区 / 项目键 / 默认）与 manager 的 cwd 状态、rest 认证头与错误映射（ProductSite 入参）、jira / confluence client（假 fetch 捕获 URL / init / 响应）、tools execute（假 deps + stubGlobal fetch，产物 lossless、meta 形状与 hint 传参）、store（mock api 模块，含 workspaceCwd 随附）、host 六路由（假 ctx / credentials / configEditor 全链路 + 信任边界 + cwd 桥 + server 双凭据写入与按产品清除）。集成测试手动 `test:integration`：本地 HTTP 服务器模拟 Atlassian 端点走真 socket（Basic 头服务端核验、搜索→详情→评论链路、401 映射）。用户凭据不进任何测试。
