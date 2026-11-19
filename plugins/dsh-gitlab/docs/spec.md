# dsh-gitlab 行为规格

本文件承载 @weilence/dsh-gitlab 的功能与行为规格：是什么、怎么表现；取舍理由见 [docs/decisions.md](decisions.md)，易错与禁止事项见 [docs/traps.md](traps.md)，测试见 [docs/tests.md](tests.md)；全仓约定见根 AGENTS.md 文档索引，本文只记插件特有事实。

## 插件定位

- 插件详情页配置分区「GitLab」：多站点连接管理 + 一个 `glab` CLI 透传模型工具。用常驻成本约 200 token 的单工具替代 GitLab MCP 约 2 万 token 的几十个工具 schema，能力经 glab 全量覆盖（`glab api` 可达任意 REST / GraphQL 端点）。
- 插件不代管凭据：站点只存根地址，认证走用户自己的 glab 登录态（keyring / 配置文件 / 用户自己的 `GITLAB_TOKEN` 环境变量均可）；执行时 env 只注入 `GITLAB_HOST` 选站。
- HTTP 层走 `@dsh-plugins/shared/http` 的同源请求约束（回环 Host 校验、`sec-fetch-site` 跨站拒绝、请求体上限）；读取走 `@dsh-plugins/shared` 的 errMsg，host↔client wire 类型集中在 `src/shared.ts`。

## 结构导览

- `src/index.ts`：apply 装配。`inject: ['tools', 'webServer', 'configEditor']`（三项都是核心依赖，缺席即整行不激活）。先 `sites.refresh()` 建快照，再注册工具与五条面板路由（sites / cwd 桥 / save / delete / test）；`ApplyOptions`（runGlab / glab）是测试注入 seam。`testSite` 是连接测试的实现（`glab api user --hostname <host>`，探测失败是 200 + ok/reason 的结论而不是异常）。
- `src/shared.ts`：双端 wire 类型与常量（路由路径、`SiteDraft`——name / url / workspaces / default，无凭据字段；`GlabStatusView` 二进制探测视图；`hostOf` URL → GITLAB_HOST 主机名）。
- `src/sites.ts`：站点注册表。站点元数据存本插件行 config（`configEditor.configuration()` 现读——profile 覆盖非空以覆盖为准，写入走 `ctx.configEditor.edit`）；`glabPath` 可选配置指定二进制路径。`normalizeSites` 把非法行降级为 problems 不炸整表；`chooseSite` 选站顺序见下节。
- `src/glab.ts`：spawn 层——`runGlab`（argv 直传不经 shell、`BoundedCapture` 头尾各 16K 有界捕获、StringDecoder 防多字节截断、超时 SIGKILL 并销毁 stdio 流后返回部分产物置 timedOut、调用方取消原样抛 AbortError）、`displayCommand`（产物展示用的 argv 引号化）、`glabCandidates`（候选解析顺序见 docs/traps.md）、`resolveGlabStatus`（首个可执行候选 + 版本探测）。
- `src/tools.ts`：`defineTool` × 1（`glab`）。工具描述内置子命令速查与 `glab api` 兜底指引；参数 args / site / cwd / timeoutSec（1–300，缺省 60，超最大值进程超时外层留 10s 收尾余量）；output schema 含 site / command / exitCode / stdout / stderr / truncated / timedOut / durationMs；产物经一次 JSON 往返剔除 undefined；**无 presentationMeta**——单工具产物走宿主通用卡（取舍见 docs/decisions.md）。
- `src/client.tsx`：client apply。plugins.bundle.config（keyed 包名，自家插件详情页配置分区）+ cwd 上报桥（sessions.list 快照 → `/dsh-gitlab/cwd`，上报失败静默、list 请求带 cwd 兜底）。无工具卡片。
- `src/client/`：`locales.ts`（NS `dsh-gitlab`，zh 键集事实源）、`api.ts`（bridge client，自定义头 `x-dsh-gitlab`）、`store.ts`（useSyncExternalStore 三件套 + `NoticeRelay` 操作反馈通道）、`SitesSection.tsx`（glab 状态行 + 站点卡片 + 行内表单 + 测试结果 + ConfirmDialog + NoticeToast；取消 / 关闭 / 删除 / 保存用宿主 common 词条）。

## 站点模型与选站

- `SiteDraft`：`name`（小写 slug，`^[a-z0-9][a-z0-9-]{0,31}$`，工具 site 参数按它寻址）、`url`（GitLab 根地址，http(s) 校验 + 去尾斜杠）、`workspaces?`（关联工作区目录绝对路径，归一为正斜杠、无尾分隔符、去重）、`default?`（全表至多一个为 true）。
- 存储：本插件行 config 的 `sites` 数组（两层用户 patch 可直接改，`normalizeSites` 把无法通过校验的行降级为 problems 展示，工具一律忽略这些行）。
- 选站顺序（工具与测试探测共用 `chooseSite`）：显式 site 参数（存在即以其为准，不存在报错列名）→ 当前工作区命中站点 workspaces 且**唯一**命中 → 默认站点 → 全表仅一站 → 报错列出可选站点名（绝不猜）。
- 工作区 cwd：以 Web 客户端上报的主视图会话工作目录为准（client 订阅推送 + list 请求携带兜底）；宿主刚启动、客户端未连时自动跳过工作区匹配。Windows 路径比较忽略大小写。

## 生效链路

- 站点写路由 → `configEditor.edit` → Loader 走普通更新路径 → 本插件 fiber 重挂 → 工具 / 路由 / 快照整体重建；没有 HMR 依赖，也没有重启需求。
- 工具 `when` 同步读快照：glab 二进制不可用或没有站点时，工具整体不进模型面；glab 二进制状态在 refresh 时重建（apply 时 + 每次写路由后），面板「刷新」即重探测。
- 工具与测试探测每次执行现读站点配置，不做进程内缓存。

## 面板行为语义

- 挂 `plugins.bundle.config` 槽位（插件详情页，描述与 rows 之间）：页面头部已是插件名与描述，`Panel` 整体无头部（根 docs/panel.md 例外条款）；详情页是全宽主面板，不再走 `useWideSettingsDialog()`。
- 顶部 glab 状态行：探测到显示路径与版本；未找到显示安装与 `glabPath` 指引 + 刷新按钮（重探测入口常驻）。
- 站点为可展开卡片：行内新建 / 编辑表单（名称 / 地址 / 关联工作区 / 默认站点勾选），提交校验（slug 重名、URL 形态）失败行内常驻；「测试连接」逐行执行 `testSite`，结果按站点名归档展示。
- 一次性操作反馈（保存 / 删除成功）走 `@dsh-plugins/client-ui` 通知套件：store 持 `NoticeRelay`（文案事件时间取词 emit），面板经 `useNotice` + `NoticeToast` 显示——分区未挂载即丢弃，重开详情页不重放旧 toast。
- 无效配置行（problems）在列表上方常驻展示，指引到 cordis.patch.yml 修正。
