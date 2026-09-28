# dsh-remote

设置页「远程开发」插件，包名 `@weilence/dsh-remote`（裸名 `dsh-remote` 在 npm 已被第三方包占用——远端安装因此不走 registry，见部署约定）：经 OpenSSH 别名管理远端机上的完整 dsh web 实例（部署 / 连接 / 断开），并拥有全部跨机同步能力（skills / MCP / 插件）——dsh-skills / dsh-mcp 保持纯本地管理插件、不感知远端。

## 结构

- `src/index.ts`：host half，九个 HTTP 桥路由（state / local-rows / save / delete / test / deploy / connect / disconnect / sync）；栅栏与 JSON 读写来自 `@dsh-plugins/shared/http`；`applyWithEngine` 是测试注入口；部署的本地效应也在此接线（`localDshVersion` / `localPluginVersion` / `packPlugin` staging 组装 npm tarball 布局 + 系统 tar / `pushFile` tgz 二进制经 ssh stdin 落盘）。
- `src/engine.ts`：连接状态机（相位 + 进行中操作 + running 事实）与全部操作流程（部署步进、连接轮询、三类同步）；`beginOp` 同步预占互斥，长操作 fire-and-forget，面板轮询 GET /state 观察。
- `src/ssh.ts`：ssh 执行器（node:child_process 直 spawn + 错误分类）、`bash -lc` 登录 shell 包装（npm 全局 bin 进 PATH）、tar-over-ssh 单通道、`ssh -N -L` 转发句柄。
- `src/launch.ts`：远端启动行 `dsh web: <url>` 的宽容解析（端口 + token；格式无版本契约）。
- `src/patchDoc.ts`：远端 patch 的注释保留合并（按行 id 整块 upsert / 移除；编辑面比 dsh-mcp 的 patchFile 小）。
- `src/localenv.ts`：本机清单读取（skills 两根扫描、两层 patch 的 MCP 行 fold 与插件行——插件行含安装形态与包定位：层 package.json dependencies 的 link:/file: spec 为本地、spec 目标即包根；registry 行定位层内 node_modules 实体）——全部只读。
- `src/connections.ts`：`$DSH_HOME/dsh-remote.json` 持久化（连接库 + 同步 manifest）与保存请求校验。
- `src/client/`：面板；连接为可展开卡片（状态 pill + 动作按钮按相渲染，行上带「同步…」与「删除」），行内编辑表单只管基本信息；三类同步的勾选清单在 SyncDialog（同步弹窗：skills / MCP / 插件 + 插件安装方式，确认即保存清单并一次 `sync all`）；HTTP 封装用 `@dsh-plugins/shared/api`（自定义头 `x-dsh-remote`）。

## 改动约定

- 远端 profile 固定 `web`（`REMOTE_PROFILE` 常量；面板无输入、wire 无字段。shipped web 模板含 dsh-web-app——`--no-open`/`--port 0` 是它的 flag、`dsh web:` token 行由它输出；headless 模板是一次性 agent，两者缺一连接即不成立）；远端 dsh 版本部署时对齐本机运行时（host 侧沿 node_modules 查找序探测 `@deepseek-ai/dsh-app-boot/package.json`，解析不到装 latest）。
- 三类同步一律手动触发（SyncDialog 一次 all 或单类），连接路径零同步动作；skills 按连接勾选的 skillNames 推送（tar 只打包勾选名，取消勾选的按 manifest 跟踪删除）；「同步本地插件」逐插件版本对比后分流：本地路径安装恒本地打包传输（未发布的开发版本也能到达远端），registry 插件按连接选项 `sync.registryPluginInstall` 选「本地传输」或「远端 npm 下载（add name@本机version）」；取消勾选按 manifest `remove`（只移除本插件装过的）；skills / MCP 同理跟踪式删除，远端手装内容零接触。
- 远端装本插件不走 registry（裸名被第三方占用）：部署时对比远端 `node_modules/@weilence/dsh-remote` 的 version 与 profile 登记和本机一致则跳过；否则 `packPlugin` 本地组装 tgz（npm tarball 布局，依赖构建产物 lib/ 已存在）→ `pushFile` 落盘 `~/.dsh/dsh-remote/payload/` → `dsh plugin add "$HOME/....tgz"`；装毕读回远端 package.json 的 version 防假阳性（add 退出码 0 不等于装上——旧实现只查 `dsh -V`，实测掩盖过未装）。
- 插件激活写远端 profile package.json 的 `dsh.profile.bundles`（不是 patch 行）；MCP 下发写远端 `<profile>/cordis.patch.yml`，行 id 沿用 `mcp-<serverName>`，远端 dsh-mcp 面板可无缝接手。
- 本插件不做第二套远端状态存储：连接库持久化在 `$DSH_HOME/dsh-remote.json`；运行态（相位 / 转发子进程 / pid）只驻内存，宿主重启即回 idle。
- ssh / tar 经 node:child_process 直 spawn：宿主侧受信代码、用户从设置页发起，不经模型沙箱；认证完全复用用户 OpenSSH 配置。
- 远端写操作三处固定：`~/.dsh/dsh-remote/`、`~/.dsh/profiles/<name>/`、两个 skills 根；一律 tmp+mv 原子落盘或幂等命令。
- `dsh web:` 启动行解析保持宽容（前缀 + 首个 URL + token query），不假设路径形态。

## 陷阱

- 回空库路径必须字面量新建对象，不得展开共享默认值——浅拷贝共享 `connections` 数组引用，一次 push 污染所有空库读取方（已修过一次，别再犯）。
- 远端命令统一 `bash -lc` 包装：非交互 ssh 不读用户 profile，nvm 装的 node / npm 全局 bin 会不在 PATH 上。
- `dsh plugin` 的 `--profile` 必须在子命令前（Commander requiredOption 先于 variadic args）。
- 本机（及插件同步清单）对「本插件自身」的排除要同时匹配 `@weilence/dsh-remote` 与旧裸名 `dsh-remote`——本机 link 安装在改名重装前的过渡期还挂着旧名行，漏排会把自身当业务插件同步出去。
- `SshExecOptions.stdin` 是 `string | Uint8Array`：tgz 走二进制原始字节，ssh 通道本身二进制安全；远端版本探查的两条 cat 命令文本不同（探查带 `2>/dev/null || true` 后缀、verify 不带），测试靠它区分两次响应。
- `packPackage` 对任意包根整目录拷贝（排除 node_modules / .git，过滤只看根内相对段——registry 实体的根本身就位于 node_modules/.pnpm 之内），先 realpath 落到 .pnpm 真实目录；tgz 命名从包 manifest 的 name/version 派生（@scope/name → scope-name）。
- 插件同步的版本对比在版本不可读（本机包定位失败或远端 cat 空）时保守重装——tgz 推送幂等，宁可重推不可漏装。
- 连接轮询按尝试次数上限（180s / 2s）而非墙钟 deadline——测试的即时 delay 会把墙钟循环卡满真实时长。
- 健康检查只验证「隧道上取到任何 HTTP 响应」：远端对无凭据 `GET /` 应答 401（index 由 browser-auth 把守），按状态码判活会把好隧道误杀（实测踩过）；pid 存活时 start 复用旧实例，重试连接不叠加 nohup 孤儿。
- MCP 下发 / 插件安装写入后依赖远端实例的 HMR 在线应用；无 HMR 的组合需断开重连，面板有提示（重启实例会换 token，不做自动重启）。
- `yaml` 是 host 半唯一内联的 node_modules 依赖（`host.bundle: ['yaml']`）；新增运行时依赖须显式进 bundle。
- host half 变更需重启宿主；client half 刷新页面即生效。

## 测试

`pnpm --filter @weilence/dsh-remote test`：launch / patchDoc / connections 纯函数单测；engine.test.ts 用 fake ssh / 转发 / 扫描依赖做全链集成（部署步进含 tgz 推送与版本对比、连接 token 解析、三类同步、互斥）；host.test.ts 假 ctx + 临时目录两层 patch 做路由往返。
