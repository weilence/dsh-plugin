# dsh-gitlab 已确认决策

本文件承载已确认的行为决策与取舍理由（为什么是这个行为）；行为表现见 [docs/spec.md](spec.md)，实证与禁止事项见 [docs/traps.md](traps.md)。

- **单工具架构（定稿）**：GitLab MCP 版注入约 2 万 token 的几十个工具 schema；本插件常驻成本约 200 token，能力经 glab 全量覆盖（`glab api` 可达任意 REST / GraphQL 端点）。用上下文成本换结构化 schema 的权衡已做过——新增能力优先扩展工具描述里的速查或依赖 glab 子命令，确需第二个工具时先回到方案层。
- **认证外包给 glab 登录态**：插件不代存 token。站点只存根地址，执行时注入 `GITLAB_HOST` 选站；token 轮换、多站点各带各的凭据都由 glab 原生机制（keyring / 配置文件 / 环境变量）承担，插件零凭据字段、零凭据存储，攻击面最小。
- **选站「唯一命中才自动选」**：显式 site → 工作区唯一命中 → 默认站点 → 全表唯一 → 报错列名；歧义绝不猜——猜错站点的写操作（mr merge 等）代价远大于一次报错。
- **超时返回部分产物而非无限等待**：`timeoutSec` 到点 SIGKILL 并返回已捕获输出（`timedOut: true`），模型可据此加大超时重试；取消则原样抛 `signal.reason` 落宿主 ABORTED 语义。两者语义分离，不共用一条错误路径。
- **cwd 由 Web 客户端上报、不猜进程 cwd**：宿主进程 cwd 与会话工作区无关；工作区关联的事实源是主视图会话的工作目录（官方 sessions.list 快照），client 订阅推送 + list 请求携带兜底，上报失败静默。
- **单工具产物无 presentationMeta**：单工具走宿主通用卡；四件套（schema / render / presentationMeta / 卡片）按 dsh-atlassian 约定仅在多工具需要区分卡面时才值得引入。
- **站点元数据存本插件行 config**：跟随两层用户 patch 的 profile 覆盖语义，用户能手改（`normalizeSites` 降级展示非法行）；不另设插件私有存储。
