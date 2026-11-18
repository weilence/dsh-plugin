# docs/traps.md — 陷阱

本文件承载实证事实、易错点、禁止事项与事故记录：漏看会写错代码或误判行为的部分。行为规格见 [spec.md](spec.md)，人拍板的取舍见 [decisions.md](decisions.md)。

## 实证事实（远端 API 现状）

- Jira Cloud 搜索走新端点 `/rest/api/3/search/jql`（旧 `/search` 已被 Atlassian 移除），且不保证返回 `total`——截断判定在 total 缺席时改看 `nextPageToken`。
- Jira 评论端点默认最旧在前，且没有按作者过滤的服务端参数——只能用 `orderBy=-created` 从最新往回逐页扫描（`startAt` 翻页、扫描上限 200 条防机器人刷屏拖垮），排除名单在扫描时过滤。
- Confluence 检索必须 v1（`/rest/api/search`，cloud 带 `/wiki`）——v2 尚无等价检索面。

## schema 与产物链路

- 宿主统一 schema DSL 的 object 节点**必须显式 `additionalProperties`**；`required` 编写时是每个属性上的注解，defineTool 归一化后在 output.schema 里变成键名数组；产物类型由 schema 推断，execute 返回 `JSON.parse(JSON.stringify(x))` 的 any 恰好对齐推断与 JsonValue 双重要求。
- 宿主管道对工具产物按 output schema **强校验**，缺字段整个调用直接失败（事故记录：`missing required property "value.site"` 即 jira `issue()` 曾漏 `site`）；client 五个方法的返回值必须逐字段满足 schema；tools 单测的形状走查器是防漂移护栏，新增工具必须把 execute 产物纳进去。

## 易错点与禁止事项

- **InjectFace 是扁平合入 props 的**：`const { store, t } = props`，不存在 `props.inject`。
- storage 正文里的 CDATA 被 `<[^>]+>` 剥标签正则吞掉，stripTags 前必须先解包。
- rest 软超时与调用方取消合流时，取消要原样抛 AbortError——包成 HttpError 会破坏宿主管道的 ABORTED 语义（行为定义见 [spec.md](spec.md)「结构导览」`src/rest.ts`）。
- `agent.steer(createUserMessage({ content, source: { kind: 'user' } }))` 是命令提交模型的唯一通道（`dsh-plan-mode` 先例）；`agent.inject` 不唤醒 agent。
- 命令 handler 禁止网络调用（强制约定见插件 AGENTS.md，取舍理由见 [decisions.md](decisions.md)）。
- 附件下载链路易漏点：`issue()` 的 fields 要显式带 `attachment`（同 description 的裁剪语义）；附件 id 无项目键线索，多站点时 `site` 参数要显式传（fail explicitly）。
- 工作区关联的 cwd 依赖 Web 客户端上报，勿改成猜进程 cwd——与 dsh-mcp 工作区档同前提（客户端未连时的回落行为见 [spec.md](spec.md)「站点与凭据模型」）。
- 「测试连接」与工具走同一 client 构造（入参已归一的 `ProductSite`），别在路由里单独拼 URL；Server / DC 两个应用的令牌不通用，别跨产品复用。
- 卡片要加固定文案必须引入 locale seat 并同步 zh / en——现状是零固定文案（取舍见 [decisions.md](decisions.md)；词典机制见仓库根 [docs/i18n.md](../../../docs/i18n.md)）。
- devDependencies 的 `@deepseek-ai/*` 平台包即使有运行时值导入（`defineTool` / `createUserMessage`）也只声明在 devDependencies——宿主运行期供给，与 dsh-zhipu-tools 的 `dsh-web` 同例（平台包外置规则见仓库根 [docs/architecture.md](../../../docs/architecture.md)）。
