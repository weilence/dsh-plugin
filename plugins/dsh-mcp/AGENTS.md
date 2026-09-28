# @weilence/dsh-mcp

设置页「MCP 管理」插件：以官方 mcp-client 组合行为唯一事实源，读写两层用户 patch——profile 层 `<profile>/cordis.patch.yml` 与 home 层 `$DSH_HOME/cordis.patch.yml`；bundle / `--patch` 覆盖引入的行只读展示。

## 结构

- `src/index.ts`：host half，四个 HTTP 桥路由（list / save / set-enabled / delete）；栅栏与 JSON 读写来自 `@dsh-plugins/shared/http`。
- `src/patchFile.ts`：cordis.patch.yml 的注释保留编辑（insert / 裸覆盖 / 启停 / 删除 / 原子落盘）。
- `src/mcpConfig.ts`：配置校验与编辑合并（对齐官方 mcp-client Config schema）。
- `src/live.ts`：Loader / 工具注册表运行态内省（结构化最小接口，防御式读取，服务缺席时降级）。
- `src/shared.ts`：双端 wire 类型与常量。
- `src/client/`：settings.section 面板；服务器为可展开卡片——点行在行内新建 / 编辑 / 查看（McpServerForm / McpServerView，编辑弹窗已移除）；HTTP 封装用 `@dsh-plugins/shared/api`（自定义头 `x-dsh-mcp`）。面板根经 `useWideSettingsDialog()`（`@dsh-plugins/client-ui`）在本分区挂载期间放大宿主设置弹窗——官方钉死 800×800 且无尺寸 API；卸载即还原。

## 改动约定

- 写入是 YAML Document 级往返：手写注释与无关行原样保留。`patchFile.ts` 的全部编辑原语都保持这一性质，新增编辑操作走 Document API，不走字符串拼接。
- 覆盖行按官方语义 fold：后行整值覆盖前行、home 层后于 profile 层；patch 替换目标行的整个 `config`，不做深合并。
- 行 id 固定 `mcp-<serverName>`；serverName 全局唯一（运行时按它预留 `mcp__<serverName>__` 工具命名空间），行 id 命名空间跨插件共享，撞其他插件行的 id 也拒绝（409）。
- 生效链路：写盘 → HMR patch watcher → 在线重整；无 HMR 组合需重启。写操作后面板自动再刷新两次（约 1.2s / 4s）兜住 watcher → Loader 重挂载窗口。

## 陷阱

- `yaml` 是 host 半唯一内联的 node_modules 依赖（`host.bundle: ['yaml']`）；新增运行时依赖须显式进 bundle，否则构建期报错而非运行期炸。
- host half 变更需重启宿主（Node ESM 缓存按 URL 命中）；client half 刷新页面即生效。
- MCP SDK（client 2.x）握手首步是 `server/discover` 探测且无超时：静默吞未知方法的自制服务器会永远停在「连接中」。排查连接问题先看服务器是否对每个带 id 的请求都有响应。

## 测试

`pnpm --filter @weilence/dsh-mcp test`：patchFile / mcpConfig / mcpImport 纯函数单测；host.test.ts 用假 ctx + 两层临时目录文件做四路由集成往返。
