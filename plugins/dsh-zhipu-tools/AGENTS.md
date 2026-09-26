# dsh-zhipu-tools

智谱 Coding Plan 工具集（中国区）：编程式挂载 in-box mcp-client 的两个官方 MCP 服务器（zhipu_search / zhipu_reader）+ 输入框状态栏用量胶囊。

## 结构

- `src/index.ts`：host half——`ctx.plugin` 编程式挂载两个 MCP 服务器 + `GET /dsh-zhipu-tools/usage` 用量桥。本插件的 `isTrusted` 是独立的信任模型（Host 必须 loopback + origin 匹配），与 `@dsh-plugins/shared/http` 的 `isTrustedFetch`（sec-fetch-site 模型）并存。
- `src/usage.ts`：open.bigmodel.cn 用量接口（宿主侧缓存：成功 4 分钟 / 错误 30 秒过期；响应超 4 M 字符拒绝解析）。
- `src/quota-shared.ts`：client 侧轮询 hook（15 秒）与文案格式化（剩余百分比、重置倒计时）。
- `src/quota-pill.tsx` / `src/quota-panel.tsx`：输入框状态栏胶囊与点击展开的详情面板。
- `src/client.tsx`：client half 接线（slots 注入胶囊）。

## 改动约定

- MCP 挂载用编程式 `ctx.plugin` 而非 patch 配置行：Authorization headers 需在 apply 时经 credentials 服务解析（配置行的 headers 只能读 `process.env`）。重连与工具同步由 in-box mcp-client 承担，单台服务器失败只记日志、不阻塞插件激活。
- 凭证按序尝试 `ZAI_CODING_CN_API_KEY` / `ZAI_API_KEY`；都缺席时插件保持激活、仅记错误日志（智谱能力不可用，用量桥返回错误结果）。
- in-box `@deepseek-ai/dsh-mcp-client` 是运行时 peer（见 package.json `peerDependencies`），host 半零内联；`clsx` 是 client 半唯一内联的 node_modules 依赖（`client.bundle`）。
- 胶囊仅在当前会话供应商为 `zai-coding-cn` 时显示；接口 percentage 是已用%，展示统一换算为剩余。

## 测试

`pnpm --filter dsh-zhipu-tools test`：trust.test.ts（`isTrusted` + shared `isLoopbackHostname` 的行为契约——含八位组 ≤255 校验）、usage.test.ts（线格式解析与缓存）。
