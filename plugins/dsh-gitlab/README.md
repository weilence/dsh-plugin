# @weilence/dsh-gitlab

DSH Web 插件：把 GitLab 接入开发流程——多站点连接管理，为模型提供一个 `glab` CLI 透传工具（合并请求、流水线、仓库、issue 全走 glab），在插件详情页提供「GitLab」配置面板管理站点与 glab 环境探测。

用**一个常驻工具**替代 GitLab MCP 的几十个工具 schema：MCP 版注入约 2 万 token 的工具定义，本插件常驻成本约 200 token；能力经 glab 全量覆盖（`glab api` 可达任意 REST / GraphQL 端点）。

## 功能

- **站点与 glab 环境**：在插件详情页的配置面板管理多站点（站点名 + GitLab 根地址 + 关联工作区 + 默认站点），面板顶部实时显示 glab 二进制的探测结果（路径 + 版本；未找到给出安装与 `glabPath` 配置指引）。
- **认证外包给 glab 登录态**：插件不代存 token。站点存根地址；执行时以 `GITLAB_HOST` 环境变量注入选站，认证走用户自己的 `glab auth login`（keyring / 配置文件 / 用户自己的 `GITLAB_TOKEN` 环境变量均可）。token 轮换、多站点各带各的凭据都由 glab 原生机制承担。
- **测试连接**：每行站点一个「测试连接」按钮——执行 `glab api user --hostname <站点域名>`，成功显示登录用户名，失败原样显示 glab 报错（未认证 / token 失效 / 网络不通），由用户自行处理认证。
- **模型工具（1 个）**：
  - `glab`：argv 透传执行 glab 命令，返回 stdout、stderr、退出码、耗时；`args` 逐项传递不经 shell（无注入面）；输出有界（头尾各 16K 保留 + 截断标注）；超时可调（1-300 秒，到点终止进程并返回已捕获输出）；`cwd` 参数服务 repo 上下文类命令。
  - 工具描述内置常用子命令速查与 `glab api` 兜底指引；未配置站点或 glab 不可用时整体不进模型面（不占 system prompt）。
- **多站点规则**：调用未指明 `site` 参数时——工作区关联唯一命中 → 默认站点 → 全表唯一站点 → 报错列名（不猜）。显式指明 `site` 时以其为准。

## 与 MCP 版的差异

- 常驻上下文：~200 token vs ~2 万 token（61 个工具 schema 实测 69.6 KiB）。
- 权限面：host half 以宿主权限 spawn 子进程（glab 写操作如 merge 天然可用），不受模型沙箱约束——只读沙箱会话里仍可用，而 bash 跑 glab 会被拦。
- 结构化数据：MCP 返回裁剪过的 JSON；本插件返回 glab 原样输出（需要结构化数据时用 `glab api ... --output json`）。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-gitlab
```

安装后在插件管理器打开本插件详情页添加站点；glab 未安装时先 `brew install glab`（或自定路径后在本插件行配置 `glabPath`），再认证 `glab auth login --hostname <站点域名>`。

## 限制

- glab 语义即能力边界：极老的 glab 版本可能缺新子命令，面板顶部的版本显示用于排查。
- 输出截断按字符（头 16K + 尾 16K）；需要完整大输出时让模型改用分页参数或 `glab api` 精确查询字段。
- GitLab 子路径部署（如 https://example.com/gitlab）时 `GITLAB_HOST` 只含域名，glab 按域名连接——子路径部署的站点请直接依赖 glab 自身配置。
