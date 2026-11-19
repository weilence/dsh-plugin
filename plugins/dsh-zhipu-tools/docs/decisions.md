# docs/decisions.md — 已确认决策

本文件承载已确认的行为决策与取舍理由（为什么是这个行为）；行为表现见 docs/spec.md。

- provider 的选择回归官方设置页，插件删除面板开关与全部写入路径（configEditor、路由、client half 一并移除）：官方「网页搜索与获取」页已把搜索与抓取拆成两个独立下拉且 provider 列表动态加载，本插件的 provider 自动在列；自建写入入口与官方页面重复，两套入口只会留下两套状态语义（此前成对 / 混合态判定就是为对齐官方语义而生的复杂度）。
- 改为 host-only 形状（无 client half、package.json 不声明 `dsh.client`）：面板删除后 client 侧再无职责，空壳注册是死代码；loader 里的插件行保留——host half 装载依赖它。
- 凭据在场性用同步快照、不做后台轮询：`available()` 须同步且不发网络；刷新由 `credentials/reference-updated` 事件承担（apply 时与点名本插件引用名的更新到达时重查），替代原面板状态路由的「每次读取时刷新」职责，「补配后无需重启」语义保留。滞后 `true` 由 `requireKey` 的 `WebError` 兜底、滞后 `false` 报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，两种都是清晰失败；进程环境变量不可观测是平台事实，重启即重读。
- 快照刷新路径的解析故障原文进日志：provider 调用前就能看到凭据层故障，不必等到 `web_search` 报错。
- 下拉显示名（`title`）在启动时按宿主 locale 偏好取一（显式 `zh*` 中文、其余用英文）：seam 契约里 `title` 是 `string`——官方 provider 的多语言靠客户端词典按 id 翻译，插件 provider 无此路径。宿主 user-settings 的 locale 行是官方语言设置的同一事实源，显式选择即可启动时对齐界面语言；缺席（跟随浏览器）宿主无从得知，取英文兜底而非双语并列——并列文案冗长，英文对未显式选语言者歧义最小。运行中改语言接受「重启后生效」的快照语义。选中说明（`description`）走 LocalizedText，由客户端按界面语言解析（未命中语言回退 en）。
- 抓取把 webReader 的 Markdown 正文映射为 `statusCode: 200 + kind: 'text'`：webReader 不报目标页状态码与最终 URL，口径对齐官方 Fetch API provider——「成功即目标页取回」。
- 未实现宿主 0.2.2 为 provider 接口新增的可选 `ready?(llmProvider)`（缺省即就绪，模型请求的准入门控）：凭据缺席时经 `available()`/`requireKey` 的显式失败与本插件「清晰失败」语义一致。
- 未给来源标 `summary` 字段（模型读的长摘录，`web_search` 输出取 `summary ?? snippet`）：智谱 `content→snippet` 已作为摘录 fallback 到达模型，改标无增益。
