# @weilence/dsh-mcp

设置页「MCP 管理」插件：以两份 `.mcp.json`（全局 `~/.dsh/mcp.json` 与工作区 `<cwd>/.mcp.json`）为持久化事实源，动态挂载 / 更新 / 卸载 Loader 里的 mcp-client 行；cordis.patch.yml 与其他插件挂的 MCP 行一律不读取、不展示、不修改。

## 结构

- `src/index.ts`：host half，六个 HTTP 路由（list / cwd / save / check / set-enabled / delete）+ 启动重放、文件 watcher、工作区档 cwd 跟随。
- `src/mcpFile.ts`：`.mcp.json` 文件方言——解析（合法 / 无效条目分流）、mcp-client Config 双向映射、原子落盘（tmp+mv）、内容哈希 revision（乐观并发）。JSON 无注释可保，round-trip 保留键集与键序（含未知键与顶层额外键）。
- `src/mcpApply.ts`：文件期望集 ↔ Loader 实例的挂载 diff（create / update / remove 全走 `ctx.loader` 运行时 API）。只动自己 `mcpx-` 前缀的条目；行 id 被其他插件占用时跳过并告警，不劫持。Loader 根树是内存态（`write()` 为 no-op），动态条目不会写回任何配置文件。
- `src/mcpConfig.ts`：配置校验（`normalizeDraft` 对齐官方 mcp-client Config schema）与标准 MCP JSON 粘贴解析（`fromStandardJson` / `toStandardJson`，仅 client 消费）。转换备注（notes）、单台服务器问题（problems）、顶层 ConfigError 带词典描述子（`PanelMessage`），浏览器渲染期取词；host 校验失败是纯 message（errMsg 过线，按 `{text}` 原样展示）。
- `src/probe.ts`：保存前的连接检查（stdio 经 cross-spawn 启动子进程——与官方 StdioClientTransport 相同、args 直接传递不经 shell 插值；HTTP 直接发送 initialize 握手，超时可注入）。
- `src/live.ts`：Loader / 工具注册表运行态内省（官方 `Loader` / `ToolRuntime` 类型，服务不可用时降级）；list 只取 `mcpx-` 前缀条目。
- `src/shared.ts`：双端 wire 类型与常量（`ENTRY_PREFIX` / 文件名 / 路由路径 / `entryIdOf`）。
- `src/client/locales.ts`：本插件词典（命名空间 `dsh-mcp`，zh 为键集事实源、en 编译期查全），client `apply` 经 `ctx.locale.register` 注册；slot 注册声明 `locale: NS`，组件的 `t` 由框架标准 seat 合成进 props（apply 域 `bind` 只服务导航 label thunk）；`PanelMessage`（`{key, params}` 或 `{text}`）是 store / 解析层的消息描述子，渲染期经 `messageText` 取词。单测取词用 `test/i18n.ts` 的 `makeT`（含 common 词条快照）。
- `src/client/`：settings.section 面板（导航 label 为 thunk `t('section.label')`，`t` 经框架 seat 进面板根后 props 下传全部组件；公共词取消 / 关闭 / 删除 / 保存走 common 词条）；服务器为可展开卡片——点击行即可在行内新建 / 编辑 / 查看（McpServerForm / McpServerView）；工具行与 dsh-skills 同形：裸 select 档位下拉（全局 / 工作区，localStorage 记忆，收窄的紧凑宽度）+ `SearchBox` 过滤（名称 / 端点 / 错误摘要）+ 动作按钮；JSON 粘贴无解析/导入步骤，「保存」一次完成解析、连接检查与落盘，编辑 JSON 视图由 `toStandardJson` 从草稿生成（外层键即服务器名、`type` 承载 transport、行级 disabled 停用时显式输出），解析回填经 `fromStandardJson`，高级键（extras）随草稿往返、保存时显式提交，转换备注实时渲染于 JSON 输入区下方；revision / cwd 由 store 按快照统一附到写请求。HTTP 封装自定义头 `x-dsh-mcp`。面板根经 `useWideSettingsDialog()`（`@dsh-plugins/client-ui`）加宽宿主设置弹窗。`src/client/store.ts` 的快照存在过渡态行（fiber pending/loading/unloading 的「连接中…」）时自动轮询刷新，落定即停、面板关闭（无订阅者）即停——宿主侧 fiber 转变没有任何推送通道（Loader 不发状态变化事件），轮询是唯一的自动跟进手段。
- `src/client.tsx`：订阅官方 sessions.list 快照，把主视图会话 cwd（`retainedBy.mainView > 0`）经 `/dsh-mcp/cwd` 上报 host 并同步进 store（工作区档定位事实源；上报失败静默，list 请求携带 cwd 兜底）。

## 挂载与生效链路

- 插件 apply 时读全局档并重放挂载；工作区档等 client 上报 cwd 后挂载。watcher（`fs.watch` 目录级 + 文件名过滤，200ms 稳定窗口）盯两份文件——手工编辑同样即时生效；tmp+mv 原子替换换 inode，所以盯目录不盯文件。
- 保存 / 启停 / 删除 = 写文件（revision 校验）→ 全量 diff 同步挂载。**没有 HMR 依赖、没有重启需求**：挂载走 Loader 运行时 API，当场生效。
- 插件卸载时 remove 自己名下的全部条目、关闭 watcher；patch 行与其他插件不受影响。
- 写请求一律携带读取时的 revision（内容哈希），外部修改后 409 提示刷新；工作区档写请求缺 cwd 时 409（等待 client 上报）。

## 改动约定

- 同名即编辑（覆盖写入）、新名即创建；改名 = 删除后新建。跨档同名是遮蔽语义：工作区档生效、全局档 `shadowed` 且不挂载，删除工作区档条目即恢复。
- serverName 全局唯一（运行时按它预留 `mcp__<serverName>__` 工具命名空间）；两文件之间重名走遮蔽，与不可管来源重名由挂载后的 fiber 错误呈现。
- 保存前一律经 check 接口做 initialize 握手探测（失败展示原因，再点一次「保存」显式跳过）；任何输入变动都会重置该跳过标记。
- 无效条目（名称非法、缺 command / url、类型不对）在文件里原样保留（写回身份不变），面板展示原因并允许删除，修复走手工改文件。

## 陷阱

- host half 内联的 node_modules 依赖（devDependency + `host.bundle`）：`@deepseek-ai/cordis-plugin-loader`（live.ts / mcpApply.ts 用其类型与 `Group` 判定，其对 cordis / cosmokit 的引用自动外置——cordis 由宿主供给、cosmokit 在 dependencies 里随安装解析）；`cross-spawn` 是生产依赖，自动外置。新增内联依赖须声明 devDependency 并显式进 bundle，否则构建期报错而非运行期崩溃。
- stdio 探测的 spawn 不用 `node:child_process` 直接 spawn 加 `shell: true` 的做法：shell 会把 command 与 args 拼成一条 cmd 命令行，带空格路径（Program Files 下的 node）与内联脚本（`-e` 的引号 / 括号）全部失真，且命令不存在时 Windows 报 exit 1 而非 ENOENT；cross-spawn 与官方 mcp-client（MCP SDK）同源，两平台行为一致。
- MCP SDK（client 2.x）握手首步是 `server/discover` 探测且无超时：静默忽略未知方法的自制服务器会永远停在「连接中」。排查连接问题先看服务器是否对每个带 id 的请求都有响应。
- 连接检查默认 20s 超时：stdio 首次 npx 下载可能超时（属预期，可跳过检查），勿据此直接判断配置错误；stdio 探测会再启动一个实例，绑定固定端口的服务器可能因此检查失败。
- `loader.create` 的参数类型按「无 id」声明（缺省随机生成），运行时 `ensureId` 对显式 id 原样保留——diff 依赖稳定 id，需带 id 传入（类型上做一次收窄）。
- 工作区档生效依赖 web 客户端上报过 cwd：宿主刚启动、客户端未连时工作区档不挂载，属预期；面板打开时每次 list 都带 cwd 兜底。

## 测试

`pnpm --filter @weilence/dsh-mcp test`：mcpFile / mcpApply / mcpConfig / mcpImport / probe 纯函数与探测单测；store.test.ts 用 fake timers + mock list 应答验证过渡态轮询的起停与 revision / cwd 附带；host.test.ts 用假 ctx + 假 loader（记录 create / update / remove，store 与真 Loader 同为 Dict 形态）+ 两份临时文件做六路由的完整请求-响应集成测试。
