# dsh-remote 部署与版本治理

本文件承载部署与版本治理：前置条件、部署段流程、systemd 单元托管与端口策略、启动就绪等待、版本双口径、升级与 drift、payload 打包传输，以及相应的陷阱与已确认决策；连接与隧道见 [connection.md](connection.md)，环境同步见 [sync.md](sync.md)，面板交互见 [panel.md](panel.md)。

## 结构

- `src/index.ts`：部署相关路由 `GET /version`（实例运行身份自报）与 `POST /upgrade`（与 connect 同构的契约：未知 id 404 / 缺 id 400 / 缺口令 409 / op 在途 409）；部署的本机侧准备动作在此接线（`localDshVersion` / `currentDshVersion` / `localPluginVersion` 探测、`packPlugin` / `packPackage` 经 `pnpm pack` 打包、`pushFile` 把 tgz 二进制经 ssh stdin 落盘）。
- `src/engine.ts`：`runConnect` 的部署段（探查 → dsh 对齐 → 自装 → systemd → 就绪等待）与实例版本判定；`startUpgradeRemote`（op kind `upgrade`）。
- `src/service.ts`：systemd 托管装配层——单元内容与启动 / 停止 / 轮询 / 端口探测 / 端口读取 / 存活核实六条远端命令的确定性构建（单测直接断言文本）；失败经标记行（`__NOSYSTEMD__` / `__LINGERFAIL__` / `__NOBUS__` / `__STARTFAIL__` / `__STOPFAIL__`）分类报错。
- `src/launch.ts`：远端启动行 `dsh web: <url>` 的宽松解析（端口 + token）。
- `src/localproc.ts`：本机子进程输出解码与 Windows 命令解析（`decodeLocalOutput` / `resolveWindowsPnpm`，机制与缘由见「陷阱」）。

## 前置条件

- 本机：`ssh`（Windows 10+ 自带 OpenSSH 客户端）、`tar`（bsdtar）、`pnpm`（须在宿主进程可见的 PATH 上；ssh / tar 缺失时面板顶部告警并禁用相应操作，pnpm 缺失时打包动作显式报错）。
- 远端：Linux + systemd ≥ 240（`systemctl --user` / `loginctl` 可用，且能为本用户启用 linger，否则连接显式报错；macOS 与无 systemd 的环境不受支持）+ Node ≥ 22.19（部署时检查并给出指引，不代为安装 Node）。

## 部署段（runConnect 前半）

- 连接、心跳自动恢复、手动「升级远端」、转发中断自动重连共用同一 `runConnect` 全流程，部署段幂等；已装齐时部署段立即完成。
- 步骤一·只读事实探查：九项（node / npm / pnpm / dsh 版本、本插件 package.json、profile 登记、HOME / dsh 路径 / 登录 PATH 三项服务事实）经一条标记行命令一次拿全（`__KEY__<值>` 单行协议，多行 JSON 由 `tr` 压平）——探查彼此无依赖，合并成一条命令对全平台生效（Windows 省建连、macOS/Linux 省往返）；远端 pnpm 缺失时显式失败并提示在远端手动安装，不做 corepack 自动启用。
- 步骤二·远端 dsh 版本对齐：对齐目标是**现读**的本机已装版本（`currentDshVersion`，双口径见「版本治理」）——远端旧于目标才 `npm install -g @deepseek-ai/dsh@<目标版本>` 升级，远端新于目标不降级；探测失败直接中止部署（禁 npm latest，见「陷阱」）。
- 步骤三·本插件自装（不走 registry——无 scope 的包名 `dsh-remote` 被 npm 第三方包占用）：对比远端 `node_modules/@weilence/dsh-remote` 的 version 与 profile 登记及本机版本，全部一致则跳过；否则 `packPlugin` 经 `pnpm pack` 打 tgz（发布语义：files 白名单 + prepack 即 tsdown 构建 + catalog:/workspace: 依赖落成具体 range；产物名 `<扁平化包名>-<version>-<tgz sha256 前 8 位>.tgz`）→ `pushFile` 落盘 `~/.dsh/dsh-remote/payload/` → `dsh plugin add` 安装 → 安装完成后读回远端 package.json 的 version 防假阳性（缘由见「陷阱」）。
- `running.machine`（node / npm / dsh）是部署段探查的定格——与表单「测试」同一组查询，重连刷新；远端较新跳过降级时 machine.dsh 记远端实际版本。

## systemd 实例托管

- 每次连接幂等落地单元 `~/.config/systemd/user/dsh-web.service`（内容按最新探查重建，经 cmp 比对一致不重写，变化 mv + daemon-reload + restart 生效）→ `loginctl enable-linger` 并验证（每次连接重试自愈管理员关闭 linger 的情况）→ 单元未变且 active 即复用，否则 reset-failed + restart；systemctl / loginctl 缺失、用户总线不可达、linger 开不了任一条件即显式报错（标记行），不做 nohup 回退。单元名固定 `dsh-web.service`、日志路径固定 `~/.dsh/dsh-remote/web.log`，取舍见「已确认决策」。
- 单元内容：`Type=exec`（systemd ≥ 240，start 在 exec 成功后才返回、MainPID 无竞态）+ 以探查到的 dsh 绝对路径启动 + 登录 PATH 整体注入 + `--port <选定端口>` 显式监听 + `ExecStartPre` 截断日志 + append 输出到固定日志路径 + `Restart=on-failure` / `TimeoutStopSec=15s`。
- 停启语义：stop 走单元（cgroup 整组收进程，MCP server 一起退，`TimeoutStopSec=15s` 有界收尾）；日志截断两道防线（stop 后 `: > log` + 单元 `ExecStartPre` 每次启动先截断，缘由见「陷阱」）。
- 远端实例重启后 token 必换（旧 URL 失效），端口不变（钉在单元里），浏览器 Cookie 仍有效、刷新页面即可回到会话；要彻底关闭远端实例，在远端执行 `systemctl --user disable --now dsh-web.service`。

## 端口策略

- 端口由本插件选定并写进单元（单元文件是端口的唯一事实源）——首选 3080（dsh web 自己的默认端口），占用按 `PORT_CANDIDATES` 顺延（3081–3089），全占用退回内核分配。
- 部署段探查读回 `__UNITPORT__`（不额外建连），只读不到有效端口（首连 / 旧 `--port 0` 单元）才 `buildPortProbeCommand` 探测（node 在 loopback 试绑即关，不碰运行中的实例）；钉死缘由与「复用严禁重探」见「陷阱」。

## 启动就绪等待

- 远端有界循环（`for i in $(seq 1 150)` + sleep 2，一次建连等到就绪或 300s 耗尽；窗口必须覆盖完整冷启动，缘由见「陷阱」），本地兜底超时 = 循环上限 + 建连余量；stdout 的 `dsh web:` 就绪行是唯一机器可读就绪信号，只取 token——端口与单元不一致时以就绪行为准建隧道并记 `port-drift` 步骤（隧道必须指向真实监听口）。

## 版本治理（双口径与 drift）

- 本机 dsh 版本有两个口径：**快照** `localDshVersion`（模块加载定格）与**现读** `currentDshVersion`（`getDshRuntimeVersion` 每次调用读盘）；插件版本快照 `localPluginVersion` 同样模块加载定格；两口径各自的用途与不可混用缘由见「陷阱」。
- `GET /version` 上报实例运行身份（dsh + 插件版本，模块加载时定格的快照）——连接判定的比对目标，也是远端实例上同一份代码的自报通道；`instanceVersion` 经隧道 token 换 Cookie 后请求（复用 `transport.ts` 的 `exchangeTunnelCookie`）。
- 实例版本判定：单元 active 且内容未变即复用候选——隧道上问 `/version` 与本机**现读目标**比对，dsh 相等或新于目标且插件一致才接受（秒连，token 不变）；远端较新时不降级、种下 `drift='local-behind'`；dsh 旧于目标 / 插件不一致 / 旧插件 404 / 复用实例无响应时 `stopInstance`（systemctl stop）收敛一轮回环（重启后加载刚升级的磁盘），重启后仍不匹配按原样报错。
- 运行中连接的版本漂移由心跳重算（`running.drift`，semver 比较用 shared 的 `compareDshVersion` / `dshDrift`，任一侧解析不了 = null 不驱动动作）：remote-behind = 远端可升级 → 「远端可升级」徽标 + 「升级远端」动作（见 panel.md）；local-behind = 本机版本落后 → 常驻提示，不阻断任何操作；实时结论不粘性，追平即清空。
- 手动升级远端（`startUpgradeRemote`，op kind `upgrade`，`POST /upgrade`）：与连接同一 `runConnect` 全流程——部署段幂等把远端 dsh / 插件对齐到本机现读版本，旧实例在版本判定处被 stop 后重启收敛；入口与确认弹窗见 panel.md，绝不自动升级（见「已确认决策」）。

## 远端写边界

- 远端写操作四处固定：`~/.dsh/dsh-remote/`（实例日志、askpass hook 与插件 tgz payload）、`~/.config/systemd/user/`（实例单元）、`~/.dsh/profiles/<name>/`（插件安装）、两个 skills 根；一律 tmp+mv 原子落盘或幂等命令。

## 陷阱（部署与版本）

- 本机 dsh 版本探测必须经运行时 import `@deepseek-ai/dsh-app-boot`（peer 声明保持外置，动态 import + catch 软失败）：宿主把平台包经运行时解析供给插件，静态 node_modules 目录探测在宿主形态下落空。探测失败时**禁止回退安装 npm latest**——latest 标签可能落后于 next（实测 latest=0.1.7-rc.2、0.2 线在 next），装出旧 dsh 后 `dsh plugin add` 会被 engines 版本检查拒绝（allow-version 提示即此），宁可中止部署。
- `dsh plugin add` 退出码 0 不代表安装成功：装完本插件后必须读回远端 package.json 的 version 防假阳性——旧实现只查 `dsh -V`，实测掩盖过未安装的情况。
- **插件打包只走 `pnpm pack`，禁止回退自拼 tar**：catalog:/workspace: 依赖 spec 由它落成具体 range——自拼 tar 会把字面 `catalog:` 带进 tgz，远端 pnpm 解析不了（`ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`，实际发生过）。`--json` 输出会被 prepack 脚本的 stdout 污染，产物名不解析输出，改为读全新空目录里唯一落地的 tgz。宿主进程解析不到 pnpm 时显式报错（GUI 启动不继承 shell rc 的 PATH），不静默换实现——两套打包行为会让产物不确定。
- Windows 下 pnpm 解析是显式的：`resolveWindowsPnpm` 按 PATH × 固定扩展名先找绝对路径（`shell: true` 下命令缺失不会 ENOENT，而是 cmd 报本地化错误、可读的显式报错永远走不到），`.exe` 不经 shell 直接 spawn（参数不加引号）、`.cmd` 才走 shell 加引号。cmd.exe 的本地化失败文本按控制台 OEM 代码页写管道（zh-CN 是 GBK，按 UTF-8 解即乱码），失败摘要必须经 `decodeLocalOutput` 解码——UTF-8 优先、解码含 U+FFFD 才按 chcp 代码页回退 ICU 解码器（代码页经 chcp 现查一次进程内缓存；936→gbk、950→big5、932→shift_jis、125x→windows-125x……，65001 与未知码页不回退），仅 win32 生效（实际发生过：宿主 PATH 无 pnpm 时面板显示「不是内部或外部命令」的乱码）。
- 远端 profile 的 `pnpm-workspace.yaml` 固定 `nodeLinker: hoisted`：其下 `pnpm add` 的更新判定只看 specifier（dependencies 里的 spec 字符串），不校验 tgz 字节变化——同 name@version 换内容不会重新解包，`--force` 也绕不过（实测 pnpm 11.7.0）。payload 文件名带 tgz 字节的内容盐（`<扁平化包名>-<version>-<sha256 前 8 位>.tgz`）：版本变或内容变都换 specifier、必重新解包；内容真一致则同名、远端自然跳过。插件的判等仍以版本为锚——同版本换内容不会被判为 diff，改码推远端走 bump version 或对已一致项强制重推，与自部署段、实例 `/version` 判定同一语义。
- payload 目录的 tgz 不是纯传输介质：`pnpm add <tgz>` 把 `file:<tgz>` 写进 dependencies 后长期引用，后续任何 add/install 都会重读全部 file: 依赖——装完就删会让依赖悬空，下一个无关插件的 add 以 `[ENOENT]` + 退出码 254 失败（实际发生过：清理删了刚装的 tgz）。清理只能删同包其他版本的文件（版本段锚定数字，不误删相似名包）。
- **端口必须由本插件选定并写进单元，不能交回 `--port 0`**：OS 随机分配意味着每次重启换端口——systemd `Restart=on-failure` 把实例拉到新端口上，旧 `ssh -L` 隧道永久指向死端口、浏览器 Cookie 的 authority 也变了，远端明明自愈本地却只能重连；端口写进单元后，重启（自动拉起 / 版本收敛 / 手动 restart）落回同一端口，隧道与会话自然续用。**复用连接时严禁重新探测端口**：实例自己正监听着 3080，探测必然「占用」而换端口 → 单元内容变 → restart——所以端口只从单元读（`__UNITPORT__`），探测只发生在单元没有有效端口时。
- **就绪窗口必须覆盖完整冷启动**：MCP server 串行启动且各自现场下载依赖，npm / uv 各约 2 分钟，实测两个 MCP ≈ 4 分钟，旧值 180s 让必走冷启动的路径（版本不符杀旧重启、实例崩溃后重连）必然超时；Windows 无连接复用时原先每 2s 一条 grep 意味着最多 150 次建连。就算本地提前断开，远端循环有界自灭不泄漏进程。
- 实例版本判定的事实源是**进程自报的启动时刻快照，不是磁盘当前版本**：`getDshRuntimeVersion()` 与插件 package.json 都是运行时读磁盘，而部署段在判定之前就把磁盘升级了——运行时读取会报出「新版本」而进程跑着旧代码，升级判定被完全骗过（假阴性）。快照必须在模块加载（= 进程启动）时定格：`localDshVersion`（顶层 await import）与 `localPluginVersion`（顶层 IIFE 读 package.json）都是模块级常量，远端实例与宿主复用同一份代码、同一语义；将来若把更多事实纳入判定（对齐面扩大），同样必须快照化，禁止在 `/version` 处理器里现读磁盘。
- **两个口径不可混用**：/version 自报与实例身份判定永远用快照；部署对齐目标与心跳漂移基准永远用宿主侧现读（`currentDshVersion`）——宿主磁盘不经本插件改动、无「部署段污染自身磁盘」的假阴性路径，而远端实例进程的磁盘恰恰会被部署段升级。若把现读口径误用到远端实例的 /version 上，升级判定立刻回到被污染的假阴性；若把快照口径用作对齐目标，「本机升级了、宿主没重启」的漂移永远不可见（连接还会把远端拉回旧快照版本）。
- systemd 托管下的停启语义：正常停启走单元，无需 pid 身份核验——systemd 按单元定位进程，不存在 pid 复用误杀；旧 nohup 形态的 `<id>.pid` 迁移清理已随该形态淘汰一并删除，远端遗留的旧 pid 文件是无人读写的死文件。日志截断两道防线的缘由：stop 后 `: > log` + 单元 `ExecStartPre` 每次启动（含 Restart= 自动拉起）先截断——旧就绪行不清掉，下次 poll 秒命中死实例的旧 token。
- systemd 用户服务的环境差异：用户管理器的默认 PATH 极简（nvm node、uv/npx 全不在）——单元必须整体注入探查到的登录 PATH；ssh 非交互会话的 `XDG_RUNTIME_DIR` 通常由 pam_systemd 注入但不可依赖，命令前置 `${XDG_RUNTIME_DIR:-/run/user/$(id -u)}` 兜底；linger 刚开启时用户管理器可能未起完，`daemon-reload` 有界重试（10 次 × 1s）覆盖该窗口；单元文件内容随每次连接按最新探查重建（dsh 升级换路径 / 用户改 PATH 都经 cmp 检出后 restart 生效）——不要缓存「已写过单元」的判定。

## 已确认决策（部署与版本）

以下为已拍板的行为决策及理由。

- 版本对齐方向感知，远端新于目标**不降级**：降级会让下次 systemd 重启把实例拉回旧版本线——磁盘与进程保持一致的较新版本；本机落后只经 `drift='local-behind'` 提示，不做强制。
- 绝不自动升级远端 dsh：升级会重启远端实例、中断进行中的会话——「升级远端」必须用户在 ConfirmDialog（明示两侧版本与重启后果）确认后才动。
- 远端 profile 固定 `web`（`REMOTE_PROFILE` 常量，面板无输入、wire 无字段）：shipped web 模板含 dsh-web-app（`--no-open`/`--port` 是它的 flag、`dsh web:` token 行由它输出，本插件恒传显式端口），headless 模板是一次性 agent——两者缺一则连接不成立。
- 单元名固定 `dsh-web.service`、日志路径固定 `~/.dsh/dsh-remote/web.log`，都不含连接 id：一台机器一个实例，同一台机器换别名连必须命中同一个单元、同一份日志（内容不变 → cmp 命中 → 不重写不 restart）；把 id 或插件包名写进单元名会分裂成两个实例、并让连接互相 restart。
- `dsh web:` 启动行解析保持宽松（前缀 + 首个 URL + token query）：格式无版本契约，不假设路径形态，只从中取 token（端口以单元为准）。
