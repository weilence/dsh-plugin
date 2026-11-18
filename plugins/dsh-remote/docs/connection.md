# dsh-remote 连接与隧道

本文件承载连接形态与认证矩阵、口令通道、连接状态机与持久化、本地隧道、心跳健康、转发中断自动重连与风暴抑制、dsh-sessions 传输通道，以及相应的陷阱与已确认决策；部署与版本治理见 [deploy.md](deploy.md)，环境同步见 [sync.md](sync.md)，面板交互见 [panel.md](panel.md)。

## 结构

- `src/index.ts`：连接相关路由——`GET /state`（状态快照，面板轮询与心跳的驱动源）、`POST /save`、`POST /delete`、`POST /test`（表单无状态探针：不占连接操作位、不改阶段、不要求先保存）、`POST /connect`、`GET /ssh-hosts`（`~/.ssh/config` 只读扫描，选择器用）、`POST /secret`（现场补录的口令只进宿主内存）；`applyWithEngine` 是测试注入口；生产 ssh 面由 `createSshTransport(dshHomePath())` 提供（exec / 转发 / tar 共用同一套目标参数与环境）。
- `src/engine.ts`：连接状态机（阶段 + 进行中操作 + running 事实）与全部操作流程（连接、同步、升级、删除、心跳、自动重连；部署与版本部分见 deploy.md）；`beginOp` 同步抢占互斥锁，长操作 fire-and-forget，面板轮询 `GET /state` 跟踪；口令解析 `secretOf` = 落盘口令优先、其次本次运行的会话口令表（`sessionSecrets`，`rememberSecret=false` 时的唯一落点），密码登录没有可用口令时 `beginOp` / `remoteInventory` 抛 `SecretRequiredError`（路由 409，面板据此弹补录框）。
- `src/ssh.ts`：ssh 执行器（node:child_process 直接 spawn + 错误分类 `classifySshFailure` 与失败摘要 `summarizeOutput`）、`bash -lc` 登录 shell 包装、tar-over-ssh 单通道、`ssh -N -L` 转发句柄（`buildForwardArgs`）、连接目标 → ssh 参数 / 环境组装（`buildSshInvocation`）、口令通道（`createAskpass`）。
- `src/sshconfig.ts`：`~/.ssh/config` 只读扫描（`readSshConfig`：`Host` 段取首值语义、通配 / 否定段跳过、`Match` 截断、`Include` 就地展开——`~` / `${ENV}` / glob / 深度与环检测），只供选择器展示「配置里声明的」hostname / user / port / 密钥 / 跳板。
- `src/connections.ts`：`$DSH_HOME/dsh-remote.json`（v2）持久化与保存请求校验（见「持久化与租约」）。
- `src/forwards.ts`：本地转发租约 `$DSH_HOME/dsh-remote/forwards.json`（见「持久化与租约」）。
- `src/transport.ts`：复用唯一引擎注册 `ctx.remoteTransport`，只公开连接清单及会话预览 / 导入两条 POST（见「dsh-sessions 传输通道」）。

## 连接形态与认证矩阵

- 连接目标是判别联合：`alias`（SSH 别名，认证完全交给 `~/.ssh/config`，该别名须已能免交互登录，本插件不为它补密码）或 `direct`（host / port / user / auth=key|password / identityFile，私钥路径支持 `~/`）。
- 三种登录方式：SSH 别名 / 密码 / 密钥文件（可带私钥口令）；密码与私钥口令共用同一个 `secret` 槽，但认证方式切换且未重填口令时不沿用旧值（取舍见「已确认决策」）。
- 口令生命周期：只有勾选「记住」才写盘（0600 + tmp/rename），否则口令只进引擎内存的会话口令表；宿主重启后会话口令丢失，点「连接」等操作弹现场补录框；保存允许没有口令（用户点了「清除已保存的口令」），操作前引擎抛 `SecretRequiredError`（409）；别名不接受面板口令（`/secret` 直接 400）。口令出口的强制约束见「陷阱」。
- ssh 参数矩阵（`buildSshInvocation`）：别名 = `BatchMode=yes` + 原样别名；密钥无口令 = `-i <file> -o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o BatchMode=yes`；密钥有口令 = 同上去掉 BatchMode、加 `NumberOfPasswordPrompts=1` 与口令通道；密码 = `-o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -o NumberOfPasswordPrompts=1` + 口令通道；直连统一 `StrictHostKeyChecking=accept-new`（未知主机自动记录，变更时硬失败），目标前一律加 `--` 终止选项。
- 口令通道 = `SSH_ASKPASS_REQUIRE=force` + `SSH_ASKPASS=<宿主可执行文件>` + `ELECTRON_RUN_AS_NODE=1` + `NODE_OPTIONS=--require "<hook>"` + 口令环境变量；hook 在 `<DSH_HOME>/dsh-remote/askpass.cjs`，首次使用写盘（0600）并自检（Windows 约束与缘由见「陷阱」）。
- ssh / tar / pnpm 经 node:child_process 直接 spawn（pnpm 在 Windows 是 .cmd，走 shell 并给路径加引号）；远端命令统一 `bash -lc` 包装（缘由见「陷阱」）。

## 连接生命周期

- 连接 = 部署段 + systemd 启动 + 本地隧道 + 实例版本判定（部署与版本部分见 deploy.md）；已装齐时部署段立即完成。
- 健康检查判据：只验证「隧道上取到任何 HTTP 响应」——远端对无凭据 `GET /` 应答 401（index 由 browser-auth 保护），401 也算活。
- 删除连接：本地全清（转发 + 租约 + 记录 + 会话口令），运行中可删，远端实例与已装产物不动。

## 本地隧道

- 本地口按连接 id 从首选段 13080–13111 确定性推导（`preferredLocalTunnelPort`，FNV-1a 取槽，跨重连 / 宿主重启稳定、无需持久化），bind 探测空闲即用、被占回退内核临时口、槽位空出后自动回首选；转发参数 `ExitOnForwardFailure=yes`（绑不上本地口立即退出，不留空隧道）+ `ServerAliveInterval=15` × `ServerAliveCountMax=3`（死链检测，黑洞隧道 ≤45s 显式死亡）；「健康检查不过且转发进程已死」→ 换临时口重试一次（判据缘由见「陷阱」）。

## 心跳语义（heartbeat）

- 由 host 的 `GET /state` 搭面板轮询驱动（无后台定时器，面板关掉即停）：只探 running 连接、同一连接不并发、10s 节流。
- 每拍即「测试链接」的完整查询，全走既有隧道（不新开 ssh）：`GET /`（401 也算活）+ `GET /version`（实例自报身份写进 `running.instance` 供面板行实时刷新，问不到保留上次自报）+ 版本漂移重算（见 deploy.md「版本治理」）。
- 连续 3 次失败才建一条 ssh 跑只读的 `buildHealthCommand`（ActiveState / SubState / NRestarts + 日志尾部压平成 `|`，不 start 不 restart——要不要收敛由 engine 决定）分类：`activating/reloading/deactivating` 标 `restarting` 短退避；`active` 标 `unresponsive` 退避 60s 不重启；`inactive/failed` 走 `recover()`（op kind `recover`，重跑 `runConnect` 全流程，成功回 running）；读不到状态 / ssh 失败 / 密码连接缺口令一律标 `unknown` 不动作。
- 同一轮掉线最多收敛 3 次（连续两轮健康探测才清零计数），超限 `declareDown` 判死（杀转发、清租约、error 带 systemd 事实）；结论写进 `running.health`（健康时为 null 不显示）；op 非空即跳过探测。

## 转发中断自动重连（beginAutoReconnect）

- 触发：本地转发意外退出（onExit，事件驱动——不引入后台定时器，面板关闭也在工作）且连接在 running 且无在途操作；在途操作期间转发死亡保留既有语义（error + 提示重连，操作自身的 settle / fail 随后结算）。
- 行为：复用 `runConnect` 全流程（部署段幂等、systemd 单元复用秒连），同一事件最多 3 次尝试、间隔 15s，耗尽落 error（保留最后一轮的具体原因，失败详情按 `progress.kind=reconnect` 取词）；密码连接没有可用口令（防御分支）跳过重试直接 error 指明补录出路。
- 风暴抑制：3 分钟滑动窗口内最多触发 3 次（锚点是每次转发死亡，取舍见「已确认决策」），第 4 次判「隧道起来就崩」直接落 error 停手；窗口期平静（死亡间隔超窗口）或手动连接重置计数；重试前恢复 op / 阶段（见「陷阱」）；重连成功后 `runConnect` 重置 health 计数。

## 持久化与租约

- 连接库持久化在 `$DSH_HOME/dsh-remote.json`（v2：连接库 + 同步 manifest）：连接目标为判别联合（alias / direct），落盘形态 `StoredConnection` 多 `secret` 与 `rememberSecret`（只有勾选「记住」才写盘）；`RemoteConnection` 只暴露 `secretState` 三态（saved / session / none），口令值永不出 host；v1 的 `{sshAlias}` 记录读入即迁移为别名目标；id 缺省从别名或 host 派生；写盘 0600 + tmp/rename。运行态（阶段 / 转发子进程 / pid）只驻内存，宿主重启即回到 idle。
- 本地转发租约 `$DSH_HOME/dsh-remote/forwards.json`：连接成功落盘 `{pid, localPort, remotePort, at}`，删除连接 / 转发死亡清除；引擎 load 时清扫上个宿主生命周期遗留（`ssh.ts` 的 `killOrphanForward` 核验命令行后才杀，核验工具缺失则留待下次）；短命记录、损坏即弃，不参与任何连接判定；落盘对 ENOENT 容忍（home 目录已消失即无事可写，其余错误上抛——引擎侧三处 fire-and-forget 调用不致变 unhandled rejection）。

## dsh-sessions 传输通道

- `ctx.remoteTransport` 复用唯一引擎注册，共享契约在 `@dsh-plugins/shared/remote`；只公开连接清单及会话预览 / 导入两条 POST。
- 每次请求经已连接隧道的启动 token 换取 authority 绑定 Cookie（复用 `exchangeTunnelCookie`）；接收路由仍须宿主认证与 `x-dsh-sessions` 标记；不持久化 Cookie、不跟随跳转，连接变化或提交结果不明时要求重新预览。
- 会话档案与面板由 dsh-sessions 管理；会话迁移只新增或跳过一致内容，不采用环境同步的覆盖语义。

## 陷阱（连接与隧道）

- **口令场景不能设 `BatchMode=yes`**：它是「终端前没有人」开关——password / keyboard-interactive 认证方法被整条跳过，加密私钥的加载循环在空口令试解失败后直接 `quit`（见 `sshconnect2.c` 的 `load_identity_file`），根本不会进入 `read_passphrase`，askpass 也就不会被调用。有口令可递时必须去掉 BatchMode，靠 `PreferredAuthentications` + `NumberOfPasswordPrompts=1` 保证只走预期认证并只重试一次；没有口令可递时反而要用 BatchMode 防止 ssh 等一个永远不存在的终端。
- Windows 的 `CreateProcess` 不能把 `.cmd` / 脚本当 `SSH_ASKPASS`（实测 `spawn` 直接 EINVAL）——Win32-OpenSSH 用 `posix_spawnp` 起 askpass，只认可执行映像。因此 hook 走 `NODE_OPTIONS=--require`：`SSH_ASKPASS` 指向宿主自身可执行文件，Electron 宿主需 `ELECTRON_RUN_AS_NODE=1` 才会以 Node 模式运行；hook 读到环境变量后立刻写 stdout 并 `process.exit(0)`（不 exit 的话 Node 会把 ssh 传来的提示词当成入口脚本解析而报错）；NODE_OPTIONS 里的 hook 路径用正斜杠并加双引号（路径可能含空格，反斜杠会被 NODE_OPTIONS 解析器当转义吃掉）；首次使用做一次自检，机制失效时给出明确错误而不是让 ssh 报含混的 Permission denied。
- `ssh` 的命令级失败摘要必须走 `summarizeOutput`（cleanLines 会剔除本机 ssh 客户端横幅）：直接 `stderr.trim()` 会让 OpenSSH 10 的 post-quantum 警告顶掉真实原因（已在 `classifySshFailure` 修正）；pnpm 的真实错误常打在 stdout，失败详情须合并两路输出，并剔除本机 ssh 客户端横幅（OpenSSH 10 对无 post-quantum KEX 服务端打 `** … **` 提示）对 stderr 的污染。
- 远端命令统一 `bash -lc` 包装：非交互 ssh 不读用户 profile，nvm 装的 node / npm 全局 bin 可能不在 PATH 中。
- `dsh plugin` 的 `--profile` 必须在子命令前（Commander requiredOption 先于 variadic args）。
- `SshExecOptions.stdin` 是 `string | Uint8Array`：tgz 走二进制原始字节，ssh 通道本身二进制安全。
- **刻意不做 ControlMaster 连接复用**：宿主环境实测连接 poll 的长会话两次挂死（就绪行早已写入日志、slave 等不到数据直到本地超时；加 ServerAliveInterval 保活也未能幸免），同形态独立复现（裸 ssh / node spawn / mux 全组合、新启动静默等待 124s 命中）均未重现——宿主进程环境的差异不可穷尽，按确定性优先移除；建连开销由批量执行路径消化（部署段探查九合一 + poll 远端有界循环 + verify/pid 附带，必经连接 ~9 次 → 3 次，全平台统一）。
- 转发参数的 `ServerAliveInterval` 是死链检测的前提——没有它，黑洞隧道里 ssh 进程长时间存活，onExit 不触发，自动重连永远轮不到上场；它与 ControlMaster 时代「保活也挂死」的 mux bug 是两回事（那是本地长会话缺陷，复用已整体移除），不要据此拒绝给 `-N -L` 加保活。
- **口令只允许出现在三处**：勾选「记住」时的 `dsh-remote.json`（0600）、引擎的会话口令表、ssh 子进程环境。`/state`、保存响应、进度步骤、错误详情、日志里都不得出现明文；`RemoteConnection` 只有 `secretState` 三态（saved / session / none），`toRemoteConnection` 必须整字段投影而不是展开 `StoredConnection`。
- **本地 bind 发生在连上远端之后**（实测对不可达主机在连接阶段就失败，根本走不到 bind），不能用「spawn 后短窗口看存活」判绑口失败；确定性判据是 `ExitOnForwardFailure=yes`（不加则 ssh 对绑口失败只警告继续跑，留下没有隧道的空转发进程——旧随机口时代健康检查不过的偶发「病实例自愈」就是这么撞上的）加「健康检查不过且转发进程已死」→ 换临时口重试一次；死在临时口报错不重启远端（本地问题重启无益），进程活着但不通才是实例侧问题、走复用自愈。
- 健康检查按状态码判定存活会把正常的隧道误判为失败（实际发生过：远端对无凭据 `GET /` 应答 401）。单元 active 且内容未变时 launch 复用旧实例（`reuse:`），重试连接走 `is-active` 判定不叠加新进程；**复用实例健康检查不过 = 实例病了**（旧就绪行还在、HTTP 不应答）——重启自愈一轮回环；新启动实例失败属环境 / 转发问题，报错不自愈。
- **心跳的判死与收敛都必须基于 systemd 的显式事实**：本地隧道探测失败只说明「不通」，不说明「死了」（宿主休眠、网络抖动、systemd 正在 5s 重启窗口都在其中）——连续 3 次失败后也要先跑只读的 `buildHealthCommand` 看到 `inactive/failed` 才动手；`active` 是进程卡死（重启丢现场，只报告不动手）、`activating` 是正在拉起（等一等就回来）、读不到状态 / ssh 不通 / 密码连接缺口令一律 `unknown` 不动作。自动收敛复用 `runConnect` 全流程而不是裸 `systemctl start`——部署段幂等且带上版本对齐。
- 重连失败经 `fail()` 清操作位，重试前必须恢复 op / 阶段（`runReconnect` 循环内重设）——否则重试间隙互斥打开，用户操作与下一轮尝试竞态；心跳不受自动重连干扰：op 非空即跳过探测（既有守卫），重连成功后 `runConnect` 重置 health 计数。
- 风暴抑制的时间锚点是「转发死亡」不是「重连成功」（拍板理由见「已确认决策」）。
- 返回空库的分支必须用字面量新建对象，不得展开共享默认值——浅拷贝会共享 `connections` 数组引用，一次 push 污染所有读到空库的调用方（已修过一次，勿再引入）。
- 本地转发（`ssh -N -L` 子进程）不随宿主进程退出而亡，泄漏防线三层：runConnect 开头杀旧句柄（重连覆盖句柄前必须 kill）；`fail()` 分流——同步操作失败且连接仍在（running 非空）时保留转发、阶段回 running（操作失败 ≠ 连接中断；旧行为清 running 不杀进程，正是「隧道在而面板未连接」的一个根因），其余失败杀转发清 running；`ctx.effect` 挂 `engine.dispose()` 兜底正常退出。宿主被 SIGKILL / 崩溃仍会漏——转发租约 + load 清扫兜住（`src/forwards.ts`），杀前经 `killOrphanForward` 核验命令行仍属本插件形态（防 pid 复用误杀）。注意同一 `$DSH_HOME` 起两个宿主实例会互相清掉对方的转发。排查：`lsof -nP -iTCP -sTCP:LISTEN | grep ssh` 对照 `GET /dsh-remote/state` 的 `running.localPort`，活跃转发以外的都是泄漏。

## 已确认决策（连接与隧道）

以下为已拍板的行为决策及理由。

- 移除「断开」操作：本地转发随宿主退出消失，远端实例作为 systemd 用户服务常驻（linger + 崩溃自动拉起）；下次连接按单元复用秒连、token 不变；「删除连接」只清本机记录、已保存口令与转发，远端实例与已装产物保留。
- 转发中断不再直接落 error，改为有界自动重连（事件驱动、面板关闭也在工作）：不把中断丢回给用户手动重连；重试耗尽才落 error 并保留最后一轮的具体失败原因。
- 别名连接不补密码、也不接受面板口令（`/secret` 直接 400）：给别名塞密码会覆盖配置里的认证顺序，且 `ProxyJump` 的口令提示会拿到同一份口令（跳板机与目标机口令可能不同），失败原因极难排查——需要密码时用「密码」方式新建连接，或把密钥配进 `~/.ssh/config`。
- 认证方式切换且未重填口令时不沿用旧值：私钥口令与登录密码不是一回事（两者共用同一个 `secret` 槽）。
- 密码连接允许没有口令（「清除已保存的口令」后保存放行）：操作前引擎抛 `SecretRequiredError` 走补录弹窗——不把注定失败的认证算成连接失败。
- 连接参数永远由 ssh 自己解析配置：`~/.ssh/config` 扫描层（sshconfig.ts）只供选择器展示，不模拟 `Match` 与默认值继承——摘要常缺 `Host *` 的 User / Port，属展示层近似。
- 不做第二套远端状态存储：连接库持久化在 `dsh-remote.json`，运行态只驻内存（宿主重启即回 idle）；转发租约是唯一例外，只为清扫上个宿主生命周期的幽灵转发、不驱动任何判定——使「重启即 idle」不带幽灵隧道。
- 心跳对 `active`（进程在但不应答）只报告不自动重启：重启丢现场，退避 60s 观察；`inactive/failed` 才自动收敛（复用 `runConnect` 全流程，不裸 `systemctl start`）。
- 转发中断自动重连的风暴抑制锚点是「转发死亡」不是「重连成功」：自动重连成功不清零计数——「起来就崩」的隧道恰恰要靠连续触发积累到上限才停手；把清零挂在成功上，闪断循环永远凑不满计数、抑制形同虚设，挂在一轮重试耗尽上则「每次都成功但隧道反复断」的形态漏网。复位只认两种事实：死亡间隔超过滑动窗口（3 分钟平静即重新计数）、用户手动连接（人在场 = 给机制发一轮新信用）。
