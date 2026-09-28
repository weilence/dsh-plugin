# @weilence/dsh-zhipu-tools

DSH web 插件 —— 智谱 Coding Plan 工具集（中国区）。

## 功能

- **MCP 工具**：挂载智谱官方 `web_search_prime`（搜索）与 `webReader`（网页阅读）两个 MCP 工具，profile 内全局可见；连接重试与工具同步由宿主 in-box mcp-client 承担，单台服务器失败只影响该服务器的工具。
- **剩余额度胶囊**：输入框右区显示 5 小时 / 每周 / 工具调用三个窗口的剩余百分比与重置倒计时，点击展开详情面板，可强制刷新。数据来自 open.bigmodel.cn 用量接口，宿主侧缓存 4 分钟，前端 15 秒轮询；仅当前会话供应商为 `zai-coding-cn` 时显示。

## 安装

宿主 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 均加入
`@weilence/dsh-zhipu-tools`。启动时 profile boot 会自动合并包内的
`cordis.patch.yml`，把插件插入 host composition。

## 配置

配置 `zai-coding-cn` 供应商即可：凭证由宿主 credentials 服务解析并注入
请求头，本插件自身没有任何配置项。

## 开发

```bash
pnpm --filter @weilence/dsh-zhipu-tools build
pnpm --filter @weilence/dsh-zhipu-tools typecheck
pnpm --filter @weilence/dsh-zhipu-tools test
```

机制与改动约定见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
