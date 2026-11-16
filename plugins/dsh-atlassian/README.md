# @weilence/dsh-atlassian

DSH Web 插件：把 Jira 与 Confluence 深度接入开发流程——多站点连接（Atlassian Cloud 与 Server / Data Center 通吃），为模型提供 JQL / CQL 检索与文档读取的只读工具，提供 `/jira`、`/conf` 两个斜杠命令，聊天里的工单与文档渲染为带浏览器链接的自定义卡片。

## 功能

- **站点与凭据**：设置页「Atlassian」分区管理多站点，两种形态的字段严格分开：
  - **Cloud**：一个 Atlassian 站点地址（`atlassianUrl`，如 `https://acme.atlassian.net`，Jira 与 Confluence 同域）+ 账号邮箱 + 一份 API token（两产品共用）；
  - **Server / DC**：Jira 地址（`jiraUrl`）与 Confluence 地址（`confluenceUrl`）**必须分别填写**，token 也各自独立（`jiraTokenRef` 的 Jira PAT、`confluenceTokenRef` 的 Confluence PAT——两个应用的令牌不通用）。
  - 每行站点还可声明项目 / 空间键（`projects`）与关联工作区（`workspaces`，目录绝对路径），多站点时据此自动选站。站点元数据存本插件行 config（用户可在 cordis.patch.yml 手工维护），token 存宿主凭据库（不落配置文件、不回显）；引用名缺省派生：Cloud `ATLASSIAN_<站点名>_TOKEN`、Server `ATLASSIAN_<站点名>_JIRA_TOKEN` / `ATLASSIAN_<站点名>_CONFLUENCE_TOKEN`，也可用同名环境变量兜底。每行站点可单独「测试连接」（Jira / Confluence 各自用各自的凭据探测一次轻量端点）。
- **模型工具（只读）**：
  - `jira_search`：JQL 检索，返回 key、标题、类型、状态、负责人、更新时间与浏览器链接；
  - `jira_get_issue`：读单条工单，描述 markdown 化（Cloud ADF / Server wiki markup），可带最近评论；
  - `confluence_search`：CQL 检索（知识库搜索），返回页面 id、标题、空间、摘要与链接；
  - `confluence_get_page`：读页面正文（storage → markdown），超长自动截断并支持 `offset` 续取。
  - 未配置任何可用凭据时四个工具整体不进模型面（不占 system prompt）；返回内容有界（字段裁剪 + 截断标注 + 续取参数），符合宿主 bounded outputs 约定。
- **斜杠命令**：
  - `/jira <工单号> [要做的事]`：引用工单，AI 先查工单再结合上下文概述并向你确认下一步；带「要做的事」时直接按要求处理；
  - `/jira <与 Jira 相关的请求>`：AI 自行构造 JQL 检索、把相关工单读全后回答，末尾附工单清单；
  - `/conf <主题或问题>`：知识库问答——AI 用 `confluence_search` 检索、把真正相关的文档逐篇读完后回答，附文档清单；
  - 命令不带站点参数：站点一律由配置自动关联（见「多站点规则」）。
  - 命令 handler 不做任何网络调用：校验输入后组织一句提示经 `agent.steer()` 提交，查询与展示全部由模型用工具完成。
- **聊天卡片**：四个工具各有一张 `tool.call.toolview` 自定义卡片——工单卡（key · 标题 · 状态胶囊）、检索卡（命中结果逐行全量展示、行行带链接）、页面卡；链接在新标签页打开 Jira / Confluence 原页面。未注册名回落宿主通用卡。

## 多站点规则

调用未指明 `site` 参数时按以下顺序自动选站：

1. **工作区关联**：当前会话的工作目录（主视图会话 cwd，由 Web 端自动上报）命中某站点「关联工作区」且**唯一**命中一站 → 自动选它；
2. **项目键匹配**：工单号 / JQL / CQL 里的项目键或空间键命中某站点 `projects` 且**唯一**命中一站 → 自动选它；
3. 标记「默认」的站点；
4. 全表仅一个站点 → 使用它；
5. 否则明确报错并列出可选站点名（不猜）。

显式指明 `site` 时以其为准。工作区关联依赖 Web 端连接过宿主（cwd 尚未上报时自动回落到项目键 / 默认站点）。

## 凭据与安全

- token 只存宿主凭据库（`ctx.credentials`），配置文件只携带引用名；面板只显示「已配置 / 来源」，永不回显明文，可一键清除；
- 存储值优先于同名环境变量，`unset` 后环境变量兜底重新生效；
- 面板路由与 dsh-mcp / dsh-skills 同一套同源请求约束（回环 Host 校验、`sec-fetch-site` 跨站拒绝、2 MiB 请求体上限）。

## 限制

- 复杂 Confluence 宏（嵌套表格、面板宏等）降级为纯文本提取；未识别的 ADF 节点回退文本提取——读取场景要的是可读正文，不是无损往返；
- Jira Cloud 搜索走新 `/rest/api/3/search/jql` 端点（旧 `/search` 已被 Atlassian 移除），分页用 `nextPageToken`，总数可能不返回；
- Confluence 检索走 v1 `/rest/api/search`（CQL），v2 尚无等价检索面；
- 正文默认截断 12,000 字符，`confluence_get_page` 支持 `offset` 续取。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-atlassian
```

安装后重启宿主生效；宿主启用 HMR 时刷新设置页即可看到「Atlassian」菜单。
