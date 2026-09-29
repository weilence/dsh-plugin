# @weilence/dsh-mcp

设置页「MCP 管理」插件：以官方 mcp-client 的组合行为为唯一事实源，读写两层用户 patch——profile 层 `<profile>/cordis.patch.yml` 与 home 层 `$DSH_HOME/cordis.patch.yml`；bundle / `--patch` 覆盖引入的行只读展示。

## 结构

- `src/index.ts`：host half，五个 HTTP 路由（list / save / check / set-enabled / delete）；请求校验与 JSON 读写来自 `@dsh-plugins/shared/http`。
- `src/patchFile.ts`：编辑 cordis.patch.yml 且保留注释（insert / 覆盖行 / 启停 / 删除 / 原子落盘）。
- `src/mcpConfig.ts`：配置校验与编辑合并（对齐官方 mcp-client Config schema）。
- `src/probe.ts`：保存前的连接检查（stdio 经 cross-spawn 启动子进程——与官方 StdioClientTransport 相同、args 直接传递不经 shell 插值；HTTP 直接发送 initialize 握手，超时可注入）。
- `src/live.ts`：Loader / 工具注册表运行态内省（结构化最小接口，防御式读取，服务不可用时降级）。
- `src/shared.ts`：双端 wire 类型与常量。
- `src/client/`：settings.section 面板；服务器为可展开卡片——点击行即可在行内新建 / 编辑 / 查看（McpServerForm / McpServerView，编辑弹窗已移除）；JSON 粘贴无解析/导入步骤，「保存」一次完成解析、连接检查与整批落盘。HTTP 封装用 `@dsh-plugins/shared/api`（自定义头 `x-dsh-mcp`）。面板根经 `useWideSettingsDialog()`（`@dsh-plugins/client-ui`）在本分区挂载期间加宽宿主设置弹窗——官方固定为 800×800 且无尺寸 API；卸载即还原。

## 改动约定

- 写入是 YAML Document 级 round-trip：手写注释与无关行原样保留。`patchFile.ts` 的全部编辑原语都保持这一性质，新增编辑操作走 Document API，不走字符串拼接。
- 覆盖行按官方语义 fold：后行整体覆盖前行、home 层后于 profile 层；patch 替换目标行的整个 `config`，不做深合并。
- 行 id 固定 `mcp-<serverName>`；serverName 全局唯一（运行时按它预留 `mcp__<serverName>__` 工具命名空间），行 id 命名空间跨插件共享，与其他插件行的 id 冲突同样拒绝（409）。
- 生效链路：写盘 → HMR patch watcher → 在线热重载；宿主未启用 HMR 时需重启。写操作后面板自动再刷新两次（约 1.2s / 4s），覆盖 watcher → Loader 重挂载的窗口期。
- 保存前一律经 check 接口做 initialize 握手探测（失败展示原因，再点一次「保存」显式跳过）；任何输入变动都会重置该跳过标记。

## 陷阱

- `yaml` 与 `cross-spawn` 是 host half 内联的 node_modules 依赖（`host.bundle`）；新增运行时依赖须显式进 bundle，否则构建期报错而非运行期崩溃。
- stdio 探测的 spawn 不用 `node:child_process` 直接 spawn 加 `shell: true` 的做法：shell 会把 command 与 args 拼成一条 cmd 命令行，带空格路径（Program Files 下的 node）与内联脚本（`-e` 的引号 / 括号）全部失真，且命令不存在时 Windows 报 exit 1 而非 ENOENT；cross-spawn 与官方 mcp-client（MCP SDK）同源，两平台行为一致。
- host half 变更需重启宿主（Node ESM 缓存按 URL 命中）；client half 刷新页面即生效。
- MCP SDK（client 2.x）握手首步是 `server/discover` 探测且无超时：静默忽略未知方法的自制服务器会永远停在「连接中」。排查连接问题先看服务器是否对每个带 id 的请求都有响应。
- 连接检查默认 20s 超时：stdio 首次 npx 下载可能超时（属预期，可跳过检查），勿据此直接判断配置错误；stdio 探测会再启动一个实例，绑定固定端口的服务器可能因此检查失败。

## 测试

`pnpm --filter @weilence/dsh-mcp test`：patchFile / mcpConfig / mcpImport / probe 纯函数与探测单测；host.test.ts 用假 ctx + 两层临时目录文件 + node -e 桩服务器做五个路由的完整请求-响应集成测试。
