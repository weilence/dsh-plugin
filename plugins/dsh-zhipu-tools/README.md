# @weilence/dsh-zhipu-tools

DSH web 插件：在宿主本地起一个 DeepSeek Web Tools API 兼容端点——把内置 Web 搜索设置里的「Search / Fetch API base URL」指向它，官方 `web_search` 与 `web_fetch` 即分别经智谱联网搜索与网页阅读（webReader）返回结果；不替换内置搜索插件。

## 功能

- **本地搜索端点**：host half 在 `127.0.0.1` 上监听一个固定地址（端口持久化在 `~/.dsh/dsh-zhipu-tools.json`，端口被占时自动改用系统分配并回写）。官方工具名、参数与结果卡片保持原样，实际查询改走智谱，连接或解析失败时明确报错，不会暗中回退。
- **一键接入**：在设置页「智谱搜索端点」点「写入 Web 搜索配置」，插件自动把内置 Web 搜索的配置并入你的 profile patch——`web-deepseek-api` 行指向本端点且密钥引用智谱凭据，`web` 行启用新版 Search / Fetch provider（等价于打开「启用新版 Web 搜索 API」）。只更新自家配置键，已有的其他键、注释与无关行原样保留；启用了 HMR 的宿主写入即生效，未启用时需重启宿主。
- **密钥直接复用智谱**：web_search 的密钥引用就是智谱模型的 `ZAI_CODING_CN_API_KEY`（缺席时回退 `ZAI_API_KEY`），端点每次请求现解析同一把凭据做 Bearer 鉴权——没有独立访问令牌，密钥轮换自动跟随，**不需要 DeepSeek 账号或真实 DeepSeek API Key**。
- **抓取同走智谱**：`/fetch` 由智谱网页阅读（webReader MCP）承接，返回 Markdown 正文——与官方 Fetch API 同为「解析提取后的正文」，成功即 200、目标无可用内容即明确失败；reader 多出的 title / metadata 字段丢弃。搜索与抓取共用一把智谱凭据，端点整体不依赖 DeepSeek 接口。
- **安全边界**：端点只绑 loopback，要求 loopback Host 头与非跨站标记，鉴权走 `Authorization: Bearer <智谱凭据>`（timing-safe 比对，缺失、错误与凭据未配置同形 401）；URL 不含秘密；智谱凭据只在宿主进程内解析，不进入浏览器。
- **用量展示**：由独立的 `@weilence/dsh-models` 插件承载；同时安装时，切换至 `zai-coding-cn` 会显示智谱剩余额度。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-zhipu-tools
```

（或手动把 `@weilence/dsh-zhipu-tools` 加入宿主 `package.json` 的 `dependencies` 与 profile 的 `dsh.profile.bundles`。）安装后重启宿主生效。需要宿主 0.2.1 及以上（内置「新版 Web 搜索 API」设置项）。

## 配置

优先配置 `zai-coding-cn` 供应商的 `ZAI_CODING_CN_API_KEY`；仅当该凭据缺席时才尝试 `ZAI_API_KEY`，解析故障不会切换账户。没有有效凭据时端点照常监听，但 `web_search` 调用会返回明确错误。

注意事项：

- 密钥方案对所有会话生效：宿主的账号服务只向 DeepSeek 官方推理源发放账号令牌（按目标 origin 白名单），端点在 `127.0.0.1` 上恒取不到账号令牌，内置提供方因此始终回落到智谱凭据——与当前会话用什么模型无关。
- 「写入 Web 搜索配置」按 id（`web-deepseek-api` / `web`）更新这两行并以状态文件 mtime 做并发保护；patch 文件被外部修改时会拒绝并提示刷新重试。
- 卸载本插件前，先在内置 Web 搜索设置里把 base URL 改回官方地址（或关闭「启用新版 Web 搜索 API」），否则 `web_search` 会指向已不存在的本地端点。
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
