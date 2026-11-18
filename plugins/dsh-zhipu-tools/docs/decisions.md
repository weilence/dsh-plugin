# docs/decisions.md — 已确认决策

本文件承载已确认的行为决策与取舍理由（为什么是这个行为）；行为表现见 docs/spec.md。

- 写入一律走官方 `ctx.configEditor`、不手写 patch 文件：文件锁、HMR 串行、schema 校验、home 层覆盖检测、tmp+mv 原子写与失败回滚由官方保障。
- 不把官方 provider id 写死进用户 patch：开启只叠加本插件的两个点名键，关闭走 `web` 行 next=inherited 整行清除、回退部署默认。
- 开启开关先清旧版按钮写过的 `web-deepseek-api` 覆盖行：`change` 返回 `inherited` 即官方「相等即清除」语义。
- `enabled` 判定两键都点名本插件才算开、混合态按关闭展示：对齐官方卡片的成对语义。
- 抓取把 webReader 的 Markdown 正文映射为 `statusCode: 200 + kind: 'text'`：webReader 不报目标页状态码与最终 URL，口径对齐官方 Fetch API provider——「成功即目标页取回」。
- `available()` 快照滞后不做后台轮询：滞后 `true` 由 `requireKey` 的 `WebError` 兜底、滞后 `false` 报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，两种都是清晰失败。
- 凭据缺失不禁用开关（有意区别于「前置条件不满足即禁用入口」的通用面板约定）：关闭方向仍合法，开启被拒的原文留在错误行。
- toggle 成功不弹提示：开关翻转本身就是结果；成功以响应视图为准（开关状态只认服务端事实），失败原文留在错误行。
- 凭据徽标仅在凭据不可用时出现：正常一律不出声。
- 未实现宿主 0.2.2 为 provider 接口新增的可选 `ready?(llmProvider)`（缺省即就绪，模型请求的准入门控）：凭据缺席时经 `available()`/`requireKey` 的显式失败与本插件「清晰失败」语义一致。
- 未给来源标 `summary` 字段（模型读的长摘录，`web_search` 输出取 `summary ?? snippet`）：智谱 `content→snippet` 已作为摘录 fallback 到达模型，改标无增益。
