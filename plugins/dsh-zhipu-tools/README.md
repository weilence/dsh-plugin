# @weilence/dsh-zhipu-tools

DSH web 插件：智谱 Coding Plan 工具集（中国区）。

## 功能

- **MCP 工具**：挂载智谱官方 `web_search_prime`（搜索）与 `webReader`（网页阅读）两个 MCP 工具，profile 内全局可见；连接重试与工具同步由宿主 in-box mcp-client 承担，单个服务器失败只影响该服务器的工具。
- **用量展示**：由独立的 `@weilence/dsh-models` 插件承载；同时安装时，切换至 `zai-coding-cn` 会显示智谱剩余额度。本包仅负责 MCP 工具。

## 安装

```bash
dsh plugin --profile <name> add @weilence/dsh-zhipu-tools
```

（或手动把 `@weilence/dsh-zhipu-tools` 加入宿主 `package.json` 的 `dependencies` 与 profile 的 `dsh.profile.bundles`，启动时 profile boot 会自动合并包内的 `cordis.patch.yml`，将插件加入宿主组合。）安装后重启宿主生效；宿主启用 HMR 时刷新设置页即可。

## 配置

配置 `zai-coding-cn` 供应商即可：凭据由宿主 credentials 服务解析并注入请求头，本插件自身没有任何配置项。

## 开发

```bash
pnpm --filter @weilence/dsh-zhipu-tools build
pnpm --filter @weilence/dsh-zhipu-tools typecheck
pnpm --filter @weilence/dsh-zhipu-tools test
```

机制与改动约定见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
