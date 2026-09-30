# @weilence/dsh-zhipu-tools

智谱 Coding Plan 工具集（中国区）：编程式挂载 in-box mcp-client 的两个官方 MCP 服务器（zhipu_search / zhipu_reader）。用量展示归 `dsh-models`，本包只管 MCP。

## 结构

- `src/index.ts`：host half，通过 `ctx.plugin` 挂载搜索和网页阅读两个 MCP 服务器。
- `src/client.tsx`：空 client half，保持本仓双 half 构建契约；用量 UI 与请求接口均在 `dsh-models`。

## 改动约定

- MCP 挂载用编程式 `ctx.plugin` 而非 patch 配置行：Authorization headers 需在 apply 时经 credentials 服务解析（配置行的 headers 只能读 `process.env`）。重连与工具同步由 in-box mcp-client 承担，单个服务器失败只记日志、不阻塞插件激活。
- 凭据按序尝试 `ZAI_CODING_CN_API_KEY` / `ZAI_API_KEY`；都缺失时插件保持激活，仅记录错误日志（MCP 能力不可用）。
- in-box `@deepseek-ai/dsh-mcp-client` 是运行时 peer；host half 零内联，client half 不依赖 UI 库。

## 测试

`pnpm --filter @weilence/dsh-zhipu-tools test`：验证 MCP 挂载及凭据缺失、解析失败行为；用量解析测试归 `dsh-models`。
