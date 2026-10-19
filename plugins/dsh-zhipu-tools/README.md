# @weilence/dsh-zhipu-tools

DSH web 插件：把智谱联网搜索与网页阅读（webReader）注册为 `web_search` / `web_fetch` 的可选 provider（`zhipu-search-api` / `zhipu-fetch-api`），面板开关一键把内置 Web 搜索切换到智谱——不转发线协议、不需要 DeepSeek 账号或 API Key。

## 功能

- **原生 provider**：host half 经 `ctx.web` 注册两个 provider，官方工具名、参数与结果卡片保持原样，实际查询直接调智谱 MCP 端点；连接或解析失败时明确报错，不会暗中回退。搜索的 `maxResults` 由 web 服务统一截断；抓取返回 webReader 提取的 Markdown 正文（成功即 200、目标无可用内容即明确失败，口径对齐官方 Fetch API provider）。
- **开关接入**：插件详情页的「Web 搜索走智谱」开关。开关状态实时反映 `web` 行的生效 provider 选择（两键都点名本插件才算开启，含外部改动后的最新值）；开启经官方 `configEditor` 把两个键改写到本插件的 provider（多个可用 provider 并存时必须显式点名），关闭清除用户层覆盖、回退部署默认——不把官方 provider id 写死进你的 patch。写入自带官方保障：文件锁、HMR 串行、schema 校验、home 层覆盖检测、tmp+mv 原子写与失败回滚；开启时自动清掉旧版本按钮写过的 `web-deepseek-api` 覆盖行。启用了 HMR 的宿主切换即生效。
- **密钥直接复用智谱**：provider 每次调用解析智谱模型的 `ZAI_CODING_CN_API_KEY`（缺席时回退 `ZAI_API_KEY`），无独立令牌、无配置里的密钥引用，轮换自动跟随。凭据未配置时 provider 明确报告不可用（`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`），面板按钮同步禁用并给出原因。
- **安全边界**：不经本地端口、不落状态文件；智谱凭据只在宿主进程内解析，不进入浏览器、不入日志。
- **用量展示**：由独立的 `@weilence/dsh-models` 插件承载；同时安装时，切换至 `zai-coding-cn` 会显示智谱剩余额度。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-zhipu-tools
```

（或手动把 `@weilence/dsh-zhipu-tools` 加入宿主 `package.json` 的 `dependencies` 与 profile 的 `dsh.profile.bundles`。）安装后重启宿主生效。需要宿主 0.2.1 及以上（web 服务 provider 注册接口）。

## 配置

优先配置 `zai-coding-cn` 供应商的 `ZAI_CODING_CN_API_KEY`；仅当该凭据缺席时才尝试 `ZAI_API_KEY`，解析故障不会切换账户。没有有效凭据时 provider 照常注册但报告不可用，`web_search` 调用会返回明确错误。

注意事项：

- 卸载或禁用本插件后，`web` 行仍指向 `zhipu-search-api` / `zhipu-fetch-api`：`web_search` 会报 `WEB_PROVIDER_CONFIGURED_MISSING`（清晰的失败）；重装插件，或先把开关拨回关闭（恢复部署默认）再卸载即无残留。
- 若 home 层 patch 或 `--patch` 覆盖了 `web` 行，开关写入会被 `configEditor` 明确拒绝（不产生表面成功的切换），按提示移除上层覆盖后重试。
- 智谱的[使用须知](https://docs.bigmodel.cn/cn/coding-plan/usage-notes.md)将 Coding Plan 权益限定于指定工具；MCP 文档所称兼容客户端不等于 DSH 已获套餐适用确认。请先向智谱核实此场景的授权和计费，勿将技术上可连接理解为套餐权益保证。

## 开发

```bash
pnpm --filter @weilence/dsh-zhipu-tools build
pnpm --filter @weilence/dsh-zhipu-tools typecheck
pnpm --filter @weilence/dsh-zhipu-tools test
```

机制与改动约定见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
