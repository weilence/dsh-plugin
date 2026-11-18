# @weilence/dsh-models

设置页「模型目录」插件：浏览 models.dev、把 Provider / 模型写入宿主 `llm-pi-ai` 用户层；host 侧提供支持 ETag 的目录镜像、只读生效能力接口与订阅登录接口（openai-codex 等订阅型 Provider 的 OAuth 登录入口）。

## 实现约束

- host half 不解释 models.dev 业务字段：解析、筛选、协议映射、能力编辑、写入全在 client half。
- `reasoningEfforts` 六条官方规则的 client 保存前校验与 host half `resolveModelReasoning()` 一一对应——改一侧必须同步另一侧。
- 凭据绝不下发浏览器：API Key 与订阅令牌只留在 host，用量 / 登录接口只返回展示数据。
- `ROUTE_PROVIDER_ALIASES` / `PREFERENCES` / `MIXED_PROTOCOL_PROVIDERS` 都是版本快照事实——升级 pi-ai 或 models.dev 任一侧必须复核。
- 订阅登录应答契约：decline 必须用官方 `AuthorizationDeclinedError`；prompt 自带 signal 的撤回必须以普通 Error 拒绝；空字符串是合法应答（提交按钮不得因空输入禁用）。

## 文档

- [docs/spec.md](docs/spec.md)：功能与行为规格——插件定位、结构导览、路由与 wire 契约、目录与模型匹配、写入语义、用量适配与展示语义，文末「取舍」节记录已拍板决策与理由。
- [docs/traps.md](docs/traps.md)：陷阱——实证事实（行为的背后成因）、易错点、禁止事项。
- [docs/tests.md](docs/tests.md)：测试地图——每块测试覆盖什么、如何运行。
- [README.md](README.md)：面向用户的功能说明与安装步骤（只读，不承载内部规格）。
