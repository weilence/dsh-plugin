# docs/traps.md——陷阱

本文件承载 dsh-models 的陷阱：实证事实、易错点、禁止事项与防错理由。行为规格与取舍理由见 [spec.md](spec.md)。

## 实证事实（行为的背后成因）

- 官方 `llm-pi-ai` 把全部内置 provider 声明进可配置目录，但真正注册的 route 只有配置里存在的——所以面板行列表 = 已配置 route，未配置的内置 provider 只进「新建 Provider」下拉。
- 官方 `discoverModels` 对带 `provider` 且安装目录有模型的 route **直接以注册表回答、不访问 endpoint**，且安装目录随 pi-ai 包发布、滞后于 models.dev——所以目录 route 的「获取模型」改从 models.dev 拉整份清单，而不是问 Endpoint。
- 混协议目录 provider 的目录外模型无法写入，成因在官方配置面：没有模型级 `api`，route 级 `api` 会覆盖全部目录模型，目录共用协议又不存在；pi-ai 运行层本就按 `model.api` 逐模型分发，缺口只在声明面。
- 官方 GUI 没有任何触发 `ctx.authorization` 登录流的入口——订阅登录全靠本插件的接口驱动。
- 宿主为每个 pi-ai provider 都注册登录，但 api-key 型的「登录」只是交互式问密钥（面板的 API Key 字段已是其等价物）——订阅型的判定是 **flow 带 `oauth` 方法**，不是「有 flow」。
- models.dev 改名只会让匹配静默降级到 ②③ 层，不报错。

## 易错点

- `ROUTE_PROVIDER_ALIASES` 与 `PREFERENCES` 都是快照事实（pi-ai 1.3.0 ↔ models.dev 2026-11）——升级任一侧须复核两张表。
- `MIXED_PROTOCOL_PROVIDERS` 是 pi-ai 1.3.0 快照，复核方法见 types.ts 表注释——判据是 chat 目录模型横跨协议，非 chat 子面不算。
- `reasoningEfforts` 六条官方规则的 client 保存前校验与 host half `resolveModelReasoning()` 一一对应——改一侧必须同步另一侧。
- 订阅登录 decline 必须用官方 `AuthorizationDeclinedError`——seam 靠它把「人拒绝」判定为 cancelled；prompt 自带 signal 的撤回必须以普通 Error 拒绝。
- **空字符串是合法应答**：prompt 契约没有必填标记，copilot flow 的「Enterprise URL，空 = github.com」靠空提交推进——卡片提交按钮不得因空输入禁用。
- `src/auth.ts` dispose 必须撤回仍在进行的尝试——悬空的 interaction 会让 flow 持有的 key 挂起直到进程结束。
- 本插件 `cordis.patch.yml` 禁用官方 `ui-settings-models` 行带 name 守卫：id 不再指向官方包时跳过并告警，避免误禁其他行。
- Codex 用量实现耦合 pi-ai 的私有凭据记录格式与 OAuth 刷新契约——升级宿主时须复核。

## 禁止事项

- provider 匹配不用 normalize 之类的模糊归一——只做精确比较 + 静态别名表（机制见 spec「目录与模型匹配」）。
- 不将原始 grant 或令牌传给浏览器；面板不读取、不缓存、不回显 API Key（契约见 spec「路由与 wire 契约」）。
- Copilot 企业域名不能默认为 github.com，必须明确不支持。
- 未公开接口（Codex / Copilot）响应变化时，禁止退回账单数据或猜额度——面板明确报告错误（行为见 spec「用量适配与展示语义」）。
