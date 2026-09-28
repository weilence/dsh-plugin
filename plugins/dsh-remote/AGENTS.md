# dsh-remote

设置页「远程开发」插件：经 OpenSSH 别名管理远端机上的完整 dsh web 实例（部署 / 连接 / 断开），并拥有全部跨机同步能力（skills / MCP / 插件）——dsh-skills / dsh-mcp 保持纯本地管理插件、不感知远端。

## 结构

- `src/index.ts`：host half，九个 HTTP 桥路由（state / local-rows / save / delete / test / deploy / connect / disconnect / sync）；栅栏与 JSON 读写来自 `@dsh-plugins/shared/http`；`applyWithEngine` 是测试注入口。
- `src/engine.ts`：连接状态机（相位 + 进行中操作 + running 事实）与全部操作流程（部署步进、连接轮询、三类同步）；`beginOp` 同步预占互斥，长操作 fire-and-forget，面板轮询 GET /state 观察。
- `src/ssh.ts`：ssh 执行器（node:child_process 直 spawn + 错误分类）、`bash -lc` 登录 shell 包装（npm 全局 bin 进 PATH）、tar-over-ssh 单通道、`ssh -N -L` 转发句柄。
- `src/launch.ts`：远端启动行 `dsh web: <url>` 的宽容解析（端口 + token；格式无版本契约）。
- `src/patchDoc.ts`：远端 patch 的注释保留合并（按行 id 整块 upsert / 移除；编辑面比 dsh-mcp 的 patchFile 小）。
- `src/localenv.ts`：本机清单读取（skills 两根扫描、两层 patch 的 MCP 行 fold 与插件行）——全部只读。
- `src/connections.ts`：`$DSH_HOME/dsh-remote.json` 持久化（连接库 + 同步 manifest）与保存请求校验。
- `src/client/`：面板；连接为可展开卡片（状态 pill + 动作按钮按相渲染），行内编辑表单含三类同步勾选清单（PickList）；HTTP 封装用 `@dsh-plugins/shared/api`（自定义头 `x-dsh-remote`）。

## 改动约定

- 远端 profile 固定 `web`（`REMOTE_PROFILE` 常量；面板无输入、wire 无字段。shipped web 模板含 dsh-web-app——`--no-open`/`--port 0` 是它的 flag、`dsh web:` token 行由它输出；headless 模板是一次性 agent，两者缺一连接即不成立）；远端 dsh 版本部署时对齐本机运行时（host 侧沿 node_modules 查找序探测 `@deepseek-ai/dsh-app-boot/package.json`，解析不到装 latest）。
- 三类同步一律手动触发，连接路径零同步动作（不做「连接后自动同步 skills」）；远端默认只装 dsh-remote——「同步本地插件」按勾选经 `dsh plugin --profile <name> add/remove` 增删，manifest 跟踪（只移除本插件装过的）；skills / MCP 同理跟踪式删除，远端手装内容零接触。
- 插件激活写远端 profile package.json 的 `dsh.profile.bundles`（不是 patch 行）；MCP 下发写远端 `<profile>/cordis.patch.yml`，行 id 沿用 `mcp-<serverName>`，远端 dsh-mcp 面板可无缝接手。
- 本插件不做第二套远端状态存储：连接库持久化在 `$DSH_HOME/dsh-remote.json`；运行态（相位 / 转发子进程 / pid）只驻内存，宿主重启即回 idle。
- ssh / tar 经 node:child_process 直 spawn：宿主侧受信代码、用户从设置页发起，不经模型沙箱；认证完全复用用户 OpenSSH 配置。
- 远端写操作三处固定：`~/.dsh/dsh-remote/`、`~/.dsh/profiles/<name>/`、两个 skills 根；一律 tmp+mv 原子落盘或幂等命令。
- `dsh web:` 启动行解析保持宽容（前缀 + 首个 URL + token query），不假设路径形态。

## 陷阱

- 回空库路径必须字面量新建对象，不得展开共享默认值——浅拷贝共享 `connections` 数组引用，一次 push 污染所有空库读取方（已修过一次，别再犯）。
- 远端命令统一 `bash -lc` 包装：非交互 ssh 不读用户 profile，nvm 装的 node / npm 全局 bin 会不在 PATH 上。
- `dsh plugin` 的 `--profile` 必须在子命令前（Commander requiredOption 先于 variadic args）。
- 连接轮询按尝试次数上限（180s / 2s）而非墙钟 deadline——测试的即时 delay 会把墙钟循环卡满真实时长。
- 健康检查只验证「隧道上取到任何 HTTP 响应」：远端对无凭据 `GET /` 应答 401（index 由 browser-auth 把守），按状态码判活会把好隧道误杀（实测踩过）；pid 存活时 start 复用旧实例，重试连接不叠加 nohup 孤儿。
- MCP 下发 / 插件安装写入后依赖远端实例的 HMR 在线应用；无 HMR 的组合需断开重连，面板有提示（重启实例会换 token，不做自动重启）。
- `yaml` 是 host 半唯一内联的 node_modules 依赖（`host.bundle: ['yaml']`）；新增运行时依赖须显式进 bundle。
- host half 变更需重启宿主；client half 刷新页面即生效。

## 测试

`pnpm --filter dsh-remote test`：launch / patchDoc / connections 纯函数单测；engine.test.ts 用 fake ssh / 转发 / 扫描依赖做全链集成（部署步进、连接 token 解析、三类同步、互斥）；host.test.ts 假 ctx + 临时目录两层 patch 做路由往返。
