# docs/spec.md — 行为规格

本文件承载 dsh-atlassian 的功能与行为规格：插件定位、结构导览、站点与凭据模型、工具 / 命令 / 卡片语义、生效链路。陷阱与防错见 [traps.md](traps.md)，人拍板的取舍见 [decisions.md](decisions.md)，测试覆盖见 [tests.md](tests.md)。

## 插件定位

- Atlassian 集成插件：host half 直连 Jira / Confluence REST（Cloud + Server/DC 双形态），注册五个只读模型工具与 `/jira`、`/conf` 命令；client half 在插件详情页提供站点配置面板与 `tool.call.toolview` 工具卡片。
- M1 范围只读（附件下载到本地缓存是只读链路的一部分）；写操作（评论 + 状态流转）、@ 候选、主面板工作台、事件自动化是后续里程碑，未实现。
- 面向用户的功能介绍与安装说明见 [README.md](../README.md)。

## 结构导览

- `src/index.ts`：apply 装配。`inject: ['credentials', 'tools', 'commands', 'webServer', 'configEditor']`（五项都是核心依赖，缺席即整行不激活）；先 `sites.refresh()` 建快照，再注册工具（`when` 同步读快照）、命令与六条面板路由（sites / cwd 桥 / save / delete / clear-token / test，写操作响应即最新视图，客户端不二次拉取；sites GET 的 `?cwd=` 与 cwd POST 桥都是工作区关联的 cwd 来源，dsh-mcp 同模式）；面板路由请求校验统一走 `@dsh-plugins/shared/http`（见仓库根 [docs/architecture.md](../../../docs/architecture.md)）。
- `src/shared.ts`：双端 wire 类型与常量（路由路径）；`SiteDraft` 按 kind 分形的字段与 `ProductSite` 归一连接视图（`jiraProductOf` / `confluenceProductOf`）的语义见下方「站点与凭据模型」。
- `src/sites.ts`：站点注册表——站点元数据现读本插件行 config、token 现解析自 `ctx.credentials`、`normalizeSites` 降级非法行、`chooseSite` / `requireSite` 选站，语义见下方「站点与凭据模型」。
- `src/rest.ts`：两个 client 共用的 REST 封装——入参是 `ProductSite`（base = `url`）、认证头（cloud Basic / server Bearer）、30s 软超时（调用方取消原样抛 AbortError，宿主管道按其落 ABORTED 结果）、HTTP 状态 → 面向模型的明确失败（401/403 凭据、404 未找到、429 速率受限，detail 取响应 errorMessages）；`getBinary` 供附件内容下载（content 是绝对 URL，认证头同样附带）。
- `src/jira.ts` / `src/confluence.ts`：产品 client，入参 `ProductSite`（地址已按 kind 归一：cloud 两产品同为 atlassianUrl，server 分别为 jiraUrl / confluenceUrl）；cloud 与 server 的端点差异收在各自文件顶部（Jira：cloud POST `/rest/api/3/search/jql`、server GET `/rest/api/2/search`；Confluence：统一 v1，仅 cloud 带 `/wiki` 前缀）；`fetchImpl` 参数可注入供单测替换。
- `src/markup.ts`：正文转换层——ADF → markdown（块级遍历，未知节点回退文本提取）、storage XHTML → markdown（顺序替换 + CDATA 解包 + 嵌套列表摊平，复杂宏降级）、Jira wiki markup → markdown（轻转换）、字符级截断。
- `src/tools.ts`：`defineTool` × 5。output schema 用宿主统一 DSL；产物经一次 JSON 往返剔除 undefined（lossless JSON 要求）；`presentationMeta` 投影卡片事实（kind 判别：jira-issue / jira-attachment / jira-search / confluence-search / confluence-page），持久化在 tool/result 上供卡片回放读取。
- `src/attachments.ts`：附件本地缓存层——落 `dshCachePath('dsh-atlassian', 'attachments')`（官方 cache 语义：派生数据、可重下、可手删）；`sanitizeFilename` 替换路径分隔符与控制字符防目录穿越；缓存文件名带附件 id 前缀保证唯一（同 id 覆盖即刷新）；tmp + rename 原子落盘；`buildTools(deps, options)` 的 `options.attachmentsRoot` 供测试注入临时目录。
- `src/commands.ts`：命令语法与装配——`parseJiraLine`（首段匹配工单号形态 → issue，否则整行 free）、`parseConfLine`；命令不带站点参数，站点由配置自动关联（见下方「站点与凭据模型」）；steer 文本模板面向模型（约定工具用法 + 多文档读取要求 + 引用清单格式）；handler 校验失败返回 error 文本，成功 `agent.steer(createUserMessage(...))` 后返回 success 摘要。
- `src/client.tsx`：client apply——plugins.bundle.config（keyed 包名，自家插件详情页配置分区）+ 五个 `tool.call.toolview` keyed 注册；`inject` 声明含 `sessions`，订阅官方 `sessions.list` 快照，把主视图会话 cwd（`retainedBy.mainView > 0`）经 `/dsh-atlassian/cwd` 上报 host 并同步进 store（工作区关联事实源；上报失败静默，list 请求携带 cwd 兜底，dsh-mcp 同模式）。
- `src/client/locales.ts`：本插件词典，命名空间 `dsh-atlassian`；词典组织与注册机制见仓库根 [docs/i18n.md](../../../docs/i18n.md)。
- `src/client/api.ts`：bridge client，自定义头 `x-dsh-atlassian`（子协议头惯例见仓库根 [docs/architecture.md](../../../docs/architecture.md)）。
- `src/client/store.ts`：useSyncExternalStore 三件套；store 只持事实，一次性操作反馈经 `notices`（NoticeRelay）通道送壳层常驻显示点显示——通知机制见仓库根 [docs/panel.md](../../../docs/panel.md)。
- `src/client/SitesSection.tsx`：站点卡片 + 行内表单 + 测试结果 + ConfirmDialog。
- `src/client/tool-cards.tsx`：五张卡片（meta 驱动），语义见下方「卡片语义」；locale seat 注入见仓库根 [docs/i18n.md](../../../docs/i18n.md)。

## 站点与凭据模型

- 两种形态字段严格分开（`SiteDraft` 按 kind 分形），校验拒绝交叉字段：Cloud 用 `atlassianUrl` / `atlassianTokenRef`，两产品共用一份地址与一份 token，不借用任何 Jira 字段命名；Server / DC 的 Jira 与 Confluence 是两个独立应用，`jiraUrl` + `confluenceUrl` / `jiraTokenRef` + `confluenceTokenRef` 各自独立，server 缺 confluenceUrl 即非法（cloud 带 server 字段、server 带 cloud 字段均直接拒绝）。
- 每行站点可声明项目 / 空间键（`projects`）与关联工作区（`workspaces`，目录绝对路径），多站点时据此自动选站。
- 站点元数据存本插件行 config（用户可在 cordis.patch.yml 手工维护）：`configEditor.configuration()` 现读，profile 覆盖非空以覆盖为准（与官方卡片同口径）；写入走 `ctx.configEditor.edit`，文件锁 / schema 路径 / 原子写官方保障。
- token 存宿主凭据库（`ctx.credentials`），配置文件只携带引用名、不落配置文件、面板不回显：`resolve` 每次操作现解析，`describe` 只报 configured / source，可一键清除；引用名缺省派生 Cloud `ATLASSIAN_<站点名>_TOKEN`、Server `ATLASSIAN_<站点名>_JIRA_TOKEN` / `ATLASSIAN_<站点名>_CONFLUENCE_TOKEN`，同名环境变量兜底，存储值优先（`unset` 后兜底重新生效）。
- 每行站点可单独「测试连接」：Jira / Confluence 各自用各自凭据探测一次轻量端点。
- 选站顺序（`chooseSite`，显式 `site` 参数优先）：当前工作区（`workspaces` 目录唯一命中主视图 cwd）→ hint（工单号 / JQL / CQL）按 `projects` 键词边界唯一命中（`\bABC\b`，大小写不敏感）→ 标记默认的站点 → 全表仅一个站点 → 报错并列出可选站点名（歧义不猜，见 [decisions.md](decisions.md)）。
- cwd 由 client 上报、`setWorkspaceCwd` 存档（Windows 比较忽略大小写，其余平台保留）；宿主刚启动、客户端未连时 cwd 未定，工作区匹配自动跳过，回落项目键 / 默认站点。
- `normalizeSites` 把非法行降级为 problems 不炸整表；`requireSite` 现读后委托 `chooseSite`。

## 工具语义（只读）

- `jira_search`：JQL 检索，返回 key、标题、类型、状态、负责人、更新时间与浏览器链接。
- `jira_get_issue`：读单条工单，描述 markdown 化（Cloud ADF / Server wiki markup），可带最近评论（站点 `commentExcludeAuthors` + 工具 `excludeAuthors` 合并，displayName 大小写不敏感子串，过滤数进产物 `commentsFiltered`），并附附件清单（id / 文件名 / 大小 / MIME）。
- `jira_get_attachment`：按 id 下载工单附件到本地缓存目录，返回文件路径——截图类附件模型可直接用 read_image 打开查看；单文件上限 20MB，超限显式拒绝且不拉内容。
- `confluence_search`：CQL 检索（知识库搜索），返回页面 id、标题、空间、摘要与链接。
- `confluence_get_page`：读页面正文（storage → markdown），默认截断 12,000 字符，支持 `offset` 续取。
- 未配置任何可用凭据时五个工具整体不进模型面（不占 system prompt）；返回内容有界（字段裁剪 + 截断标注 + 续取参数），符合宿主 bounded outputs 约定。
- 评论扫描行为：按 `orderBy=-created` 从最新往回逐页扫描（`startAt` 翻页、扫描上限 200 条），排除名单在扫描时过滤——端点为什么只能这样扫见 [traps.md](traps.md)。

## 命令语义

- `/jira <工单号> [要做的事]`：引用工单，AI 先查工单再结合上下文概述并确认下一步；带「要做的事」时直接按要求处理。
- `/jira <与 Jira 相关的请求>`：AI 自行构造 JQL 检索、把相关工单读全后回答，末尾附工单清单。
- `/conf <主题或问题>`：知识库问答——AI 用 `confluence_search` 检索、把真正相关的文档逐篇读完后回答，附文档清单。
- 命令不带站点参数：站点一律由配置自动关联（见「站点与凭据模型」）。
- 命令 handler 不做任何网络调用（强制约定见插件 AGENTS.md，取舍理由见 [decisions.md](decisions.md)）：校验输入后组织一句提示经 `agent.steer()` 提交，查询与展示全部由模型用工具完成。

## 卡片语义

- 五个工具各有一张 `tool.call.toolview` 自定义卡片：工单卡（key · 标题 · 状态胶囊）、检索卡（预览行显示 Jira / Confluence 与命中条数，点击展开模型渲染原文）、附件卡（文件名 · 站点）、页面卡。
- 工单与页面卡的链接在新标签页打开 Jira / Confluence 原页面；未注册名回落宿主通用卡。
- 卡片 meta 驱动、零固定文案：标题全部来自 meta 数据，失败态红点 + 错误原文（取舍见 [decisions.md](decisions.md)）；`presentationMeta` 持久化在 tool/result 上，历史回放可读。

## 生效链路

- 站点写路由 → `configEditor.edit` → Loader 走普通更新路径 → 本插件 fiber 重挂 → 工具 / 命令 / 路由 / 快照整体重建；没有 HMR 依赖，也没有重启需求。
- 工具 `when` 同步读快照（`usableCount`）：没有任何站点配置好凭据时五个工具整体不进模型面；快照在 apply 与每次写路由后刷新（fiber 重挂保证新鲜）。
- 工具与命令每次执行现读站点配置、现解析凭据——轮换 token 即时生效，不做进程内缓存。
