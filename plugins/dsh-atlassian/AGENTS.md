# @weilence/dsh-atlassian

Atlassian 集成插件：host half 直连 Jira / Confluence REST（Cloud + Server/DC 双形态），注册五个只读模型工具与 `/jira`、`/conf` 命令，client half 提供站点设置面板与 `tool.call.toolview` 工具卡片。M1 范围只读，附件下载到本地缓存是只读链路的一部分；写操作（评论 + 状态流转）、@ 候选、主面板工作台、事件自动化是后续里程碑，未实现——工具面加任何写能力都超出当前范围。

## 站点模型

- 站点按 kind 分形成两种形态：Cloud 一份 `atlassianUrl` + 一份 token，两产品共用；Server / DC 的 Jira 与 Confluence 是两个独立应用，地址与凭据各自独立，校验强制互斥（交叉字段、server 缺 confluenceUrl 直接拒绝）。
- 选站顺序（`chooseSite`）：显式 `site` → 工作区目录唯一命中 → `projects` 键词边界唯一命中 → 默认站点 → 全表唯一 → 报错列站点名；只有唯一命中才自动选站，歧义绝不猜（定稿决策见 [docs/decisions.md](docs/decisions.md)）。
- 命令不带站点参数：工具与命令的 site 一律由这套机制自动关联。

## 强制约定

- 命令 handler 禁止网络调用——它是人类直达通道，不是模型代理。
- 新增工具必须同步定义 output schema、render、presentationMeta 与卡片（kind 判别 + client 守卫），四件套缺一卡片就静默回落通用卡。

## 生效链路

- 站点写路由 → `configEditor.edit` → fiber 重挂，工具 / 命令 / 路由 / 快照整体重建；工具 `when` 同步读快照（`usableCount`），没有任何站点配置好凭据时五个工具整体不进模型面。
- 工具与命令每次执行现读站点配置、现解析凭据——轮换 token 即时生效，不做进程内缓存。

## 文档索引

- [docs/spec.md](docs/spec.md)：行为规格——插件定位、结构导览（每文件一行）、站点与凭据模型全貌、工具 / 命令 / 卡片语义、生效链路。
- [docs/traps.md](docs/traps.md)：实证事实（Jira Cloud 新端点、Confluence v1 与 CDATA、schema DSL 细节、附件链路）、易错点、禁止事项、事故记录。
- [docs/decisions.md](docs/decisions.md)：已确认决策与取舍理由（多文档检索措辞、卡片不逐行展示、多站点歧义报错等），改动需回到方案层。
- [docs/tests.md](docs/tests.md)：测试地图——单测 / 集成覆盖与运行方式。
- [README.md](README.md)：面向用户的功能介绍与安装说明。
