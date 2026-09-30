# dsh-remote

设置页「远程开发」插件，包名 `@weilence/dsh-remote`（无 scope 的包名 `dsh-remote` 在 npm 已被第三方包占用——远端安装因此不走 registry，见部署约定）：经 OpenSSH 别名管理远端机上的完整 dsh web 实例（连接（内含远端部署，即原独立的「部署」操作）/ 断开），并提供全部跨机同步能力（skills / MCP / 插件）——dsh-skills / dsh-mcp 保持纯本地管理插件、不感知远端。

## 结构

- `src/index.ts`：host half，九个 HTTP 路由（state / local-rows / remote-inventory / save / delete / test / connect / disconnect / sync）；请求校验与 JSON 读写来自 `@dsh-plugins/shared/http`；`applyWithEngine` 是测试注入口；部署在本机侧的准备动作也在此接线（`localDshVersion` / `localPluginVersion` / `packPlugin` / `packPackage` 在 staging 目录组装 npm tarball 布局 + 系统 tar，文件名内容寻址（name-version-指纹8，`payloadFileName` 派生）/ `pushFile` 把 tgz 二进制经 ssh stdin 落盘）。
- `src/engine.ts`：连接状态机（阶段 + 进行中操作 + running 事实）与全部操作流程（连接 = 部署段各步骤 + 实例启动轮询；三类同步 = 远端事实读取 + 逐条一致性判定 + 只对差异项新增/覆盖）；`beginOp` 同步抢占互斥锁，长操作 fire-and-forget，面板轮询 GET /state 跟踪。
- `src/ssh.ts`：ssh 执行器（node:child_process 直接 spawn + 错误分类）、`bash -lc` 登录 shell 包装（npm 全局 bin 进 PATH）、tar-over-ssh 单通道、`ssh -N -L` 转发句柄。
- `src/launch.ts`：远端启动行 `dsh web: <url>` 的宽松解析（端口 + token；格式无版本契约）。
- `src/patchDoc.ts`：远端 patch 的注释保留合并（按行 id 整块 upsert / 移除；编辑能力比 dsh-mcp 的 patchFile 窄）。
- `src/localenv.ts`：本机清单只读扫描（skills 两根扫描（含 `foldSkillDigest` 内容指纹折叠——远端 find|sha256 输出共用同一折叠）、两层 patch 的 MCP 行 fold（含配置签名）与插件行——插件行 = patch insert 行 ∪ 层 package.json `dsh.profile.bundles` 激活清单（link 安装的主要登记处，`@deepseek-ai/*` 平台包过滤）；行含安装形态与包定位：dependencies 的 link:/file: spec 为本地、spec 目标即包根；registry 行定位到层内 node_modules 实体；行还带包树内容指纹 `packageTreeDigest`（排除段 `PACKAGE_PACK_EXCLUDED` 与打包单一来源）与 `payloadFileName` 内容寻址命名）——全部只读。
- `src/connections.ts`：`$DSH_HOME/dsh-remote.json` 持久化（连接库 + 同步 manifest）与保存请求校验。
- `src/client/`：面板；连接为可展开卡片（状态 pill + 动作按钮按阶段渲染，行上带同步下拉（hover 展开三项菜单）与「删除」），行内编辑表单只管基本信息；菜单选类别后 SyncDialog 打开该类清单（远端事实逐条判定出徽标，非 same 默认不勾选，「隐藏已一致」开关只影响显示，same 项锁定勾选），确认即随 POST /sync 直接提交勾选项（无中间保存）；HTTP 封装用 `@dsh-plugins/shared/api`（自定义头 `x-dsh-remote`）。

## 改动约定

- 远端 profile 固定 `web`（`REMOTE_PROFILE` 常量；面板无输入、wire 无字段。shipped web 模板含 dsh-web-app——`--no-open`/`--port 0` 是它的 flag、`dsh web:` token 行由它输出；headless 模板是一次性 agent，两者缺一则连接不成立）；远端 dsh 版本在连接的部署段对齐本机运行时（host 侧运行时 import `@deepseek-ai/dsh-app-boot` 取 `getDshRuntimeVersion()`，**探测失败直接中止部署——禁止回退安装 npm latest**）。
- 三类同步一律手动触发（下拉菜单选类别 → 弹窗勾选 → 确认），连接过程不执行任何同步动作；同步入口在所有阶段常驻——skills / MCP 仅需 ssh 可达，插件安装依赖连接部署出的远端 dsh，未连接时点「同步插件」先弹出「连接远端」引导弹窗（确认后立即关闭弹窗并发起连接，连接进度由卡片上的操作 pill 呈现，连接完成后由用户重新点一次菜单）；同步语义 = **只往远端新增/覆盖，永不删除远端内容**——勾选 = 安装/覆盖，未勾选 = 不动，远端独有条目（本机没有的）不受影响；要清理远端用远端实例自己的 dsh-skills / dsh-mcp 面板。勾选项随 POST /sync 直接提交（`{id, kind, names, registryPluginInstall?}`）——不持久化在连接上、无中间保存步骤（历史上的"先 save 后 sync"两步协议、`connection.sync` 字段与 `kind=all` 已删除，"未勾选=删除"的声明式语义也已删除）。条目级「一致」判定双端同函数（shared.ts 的 `skillStatus` / `mcpStatus` / `pluginStatus`，弹窗徽标与引擎跳过共用同一实现）：skills 比内容指纹（本机 walk 与远端 `find|sha256` 管线共用 `localenv.foldSkillDigest` 折叠；隐藏路径段两侧同样跳过，目录包与 `<name>.md` 单文件取并集；刻意不比 mtime/mode）、MCP 比生效配置签名（`canonicalJson` 递归键序无关，disabled 入签）、插件比「bundles 激活 + 传输内容」——本地打包传输比包树内容指纹（`packageTreeDigest` 整树 sha256 折叠；远端一条 `node -e` 批量读版本 + 指纹，realpath 穿透 node_modules 符号链接，收集与折叠镜像 `packageTreeDigest`），远端 npm 下载比版本（npm 同版本内容不可变，版本即内容的充分代理）；指纹任一侧读不到时一律保守按不同处理（宁可重推不可漏装）。弹窗打开时 POST remote-inventory 取远端事实逐条判定：**非 same 项默认不勾选**（打开看到的是待决策清单），「隐藏已一致（N）」开关默认开（只影响显示，不改变提交集），显示出的 same 项锁定勾选不可取消（PickItem.locked，始终在提交名单内——引擎对它是 no-op），纯 same 提交置灰拦截；引擎执行时重读远端事实重跑同一判定：skills tar 只打包差异名、MCP 过滤后零变化则整次不写盘（不触发远端 HMR）、插件已激活且比对值同则跳过（值同但未激活走重装——否则已安装但未激活的插件永远无法激活），lastSync 计数为推送/写入/安装 + 跳过（已一致）。插件分流：本地路径安装恒本地打包传输（未发布的开发版本也能到达远端），registry 插件按请求选项 `registryPluginInstall` 选「本地传输」或「远端 npm 下载（add name@本机version）」；本地传输的 tgz 文件名内容寻址（`payloadFileName`：name-version-指纹8）——package.json 的 `file:` spec 持续引用当前 tgz（pnpm 后续任何 add/install 都会重读全部 file: 依赖），装成功后只清同包**更早的指纹变体**，当前文件必须保留；manifest（`dsh-remote.json` 内）只是最近一次同步的记录，不驱动任何判定。
- 远端装本插件不走 registry（无 scope 包名被第三方占用）：连接的部署段对比远端 `node_modules/@weilence/dsh-remote` 的 version 与 profile 登记及本机版本，全部一致则跳过；否则 `packPlugin` 本地组装 tgz（npm tarball 布局，依赖构建产物 lib/ 已存在）→ `pushFile` 落盘 `~/.dsh/dsh-remote/payload/` → `dsh plugin add "$HOME/....tgz"`；安装完成后读回远端 package.json 的 version 防假阳性（add 退出码 0 不代表安装成功——旧实现只查 `dsh -V`，实测掩盖过未安装的情况）。
- 插件激活写远端 profile package.json 的 `dsh.profile.bundles`（不是 patch 行）；同步 MCP 写远端 `<profile>/cordis.patch.yml`，远端行按 serverName 对齐（手写行 id 不必遵循 `mcp-<serverName>` 命名约定），远端 dsh-mcp 面板可无缝接手。
- 本插件不做第二套远端状态存储：连接库持久化在 `$DSH_HOME/dsh-remote.json`；运行态（阶段 / 转发子进程 / pid）只驻内存，宿主重启即回到 idle。
- ssh / tar 经 node:child_process 直接 spawn：宿主侧受信代码、用户从设置页发起，不经模型沙箱；认证完全复用用户 OpenSSH 配置。
- 远端写操作三处固定：`~/.dsh/dsh-remote/`、`~/.dsh/profiles/<name>/`、两个 skills 根；一律 tmp+mv 原子落盘或幂等命令。
- `dsh web:` 启动行解析保持宽松（前缀 + 首个 URL + token query），不假设路径形态。
- 远端清单读取（remoteInventory：skills 两根 `find . -type f ! -path '*/.*' | xargs -0 sha256sum`（sha256sum / shasum 择一，hasher 缺失时打 `__DSH_NO_HASHER__` 哨兵）、MCP patch 行按 serverName 取签名、插件取 bundles + `node -e` 批量读版本与包树指纹）解析失败按该类 null 降级——弹窗按「无法比对」徽标渲染但**不阻断同步**（只新增/覆盖无删除风险，最坏是无对比的全量覆盖勾选项）；ssh 连接级失败原样抛。

## 陷阱

- 本机 dsh 版本探测必须经运行时 import `@deepseek-ai/dsh-app-boot`（peer 声明保持外置，动态 import + catch 软失败）：宿主把平台包经运行时解析供给插件，静态 node_modules 目录探测在宿主形态下落空。探测失败时**禁止回退安装 npm latest**——latest 标签可能落后于 next（实测 latest=0.1.7-rc.2、0.2 线在 next），装出旧 dsh 后 `dsh plugin add` 会被 engines 版本检查拒绝（allow-version 提示即此），宁可中止部署。
- 返回空库的分支必须用字面量新建对象，不得展开共享默认值——浅拷贝会共享 `connections` 数组引用，一次 push 污染所有读到空库的调用方（已修过一次，勿再引入）。
- 远端命令统一 `bash -lc` 包装：非交互 ssh 不读用户 profile，nvm 装的 node / npm 全局 bin 可能不在 PATH 中。
- `dsh plugin` 的 `--profile` 必须在子命令前（Commander requiredOption 先于 variadic args）。
- 本机（及插件同步清单）对「本插件自身」的排除要同时匹配 `@weilence/dsh-remote` 与改名前的无 scope 包名 `dsh-remote`——本机 link 安装在改名重装前的过渡期仍保留旧名行，漏排会把自身当业务插件同步出去。
- `SshExecOptions.stdin` 是 `string | Uint8Array`：tgz 走二进制原始字节，ssh 通道本身二进制安全；远端版本探查的两条 cat 命令文本不同（探查带 `2>/dev/null || true` 后缀、verify 不带），测试靠它区分两次响应。
- `packPackage` 对任意包根整目录拷贝（忽略规则 `isPackJunkSegment` 与 `packageTreeDigest` 单一来源——排除段 + `._` 前缀，指纹所见即打包所装；过滤只看根内相对段，registry 实体的根本身就位于 node_modules/.pnpm 之内），先 realpath 解析到 .pnpm 真实目录；指纹取暂存目录（与源根经同一过滤拷贝，故与 `LocalPluginRow.digest` 同口径），算不出显式失败；tar 子进程带 `COPYFILE_DISABLE=1`（见下条陷阱）；tgz 文件名内容寻址（`payloadFileName`：scope 折平 + version + 指纹前 8 位）。
- macOS 宿主内的 tar 会把文件 xattr（com.apple.provenance 等）序列化成 `._*` AppleDouble 条目打进 tgz（在 bash 里复现不了——provenance 的读权限域不同；实际发生过：21 个 `._` 条目落地远端 node_modules），Linux 端照原样解包，污染已装指纹且同版本同名重装被 hoisted linker 跳过、永远无法收敛。双保险：`COPYFILE_DISABLE=1` 阻断产生侧，`isPackJunkSegment` 让双端指纹对 `._` 前缀免疫；远端如已被污染，`find node_modules/@weilence -name '._*' -delete` 一次即收敛。
- 远端 profile 的 `pnpm-workspace.yaml` 固定 `nodeLinker: hoisted`：其下 `pnpm add` 的更新判定只看 specifier（dependencies 里的 spec 字符串）与 tgz manifest 的 version，**不校验 tgz 字节变化**——同 name@version 换内容必须换文件名才会重新解包，`--force` 也绕不过（实测 pnpm 11.7.0；默认 isolated linker 按 integrity 重解包、无此问题——判等与命名不能依赖 linker 差异）。这就是 payload 文件名内容寻址的根据。
- payload 目录的 tgz 不是纯传输介质：`pnpm add <tgz>` 把 `file:<tgz>` 写进 dependencies 后**长期引用**，后续任何 add/install 都会重读全部 file: 依赖——装完就删会让依赖悬空，下一个无关插件的 add 以 `[ENOENT]` + 退出码 254 失败（实际发生过：清理删了刚装的 tgz）。清理只能删同包更早的指纹变体。另注意 pnpm 的真实错误常打在 stdout，失败详情须合并两路输出，并剔除本机 ssh 客户端横幅（OpenSSH 10 对无 post-quantum KEX 服务端打 `** … **` 提示）对 stderr 的污染。
- 同步的指纹对比在任一侧读不到（本机包定位失败 / 远端管道失败 / patch 语法错误）时保守按不同处理——tgz 推送与 patch 写入幂等，宁可重推不可漏装。远端哈希管线按 `hash  path` 行解析（sha256sum / shasum 同形态），路径含换行等畸形文件名会解析失败、走保守分支——官方发现层（ls -1）同样受限。
- MCP 覆盖远端手写行（同 serverName 不同 id）时先移除旧行再写本机行——这是替换被覆盖条目，不是删除远端内容；内容一致（签名相同）时即使 id 不同也不动。
- 连接轮询按尝试次数上限（180s / 2s）而非按总时长设 deadline——测试注入的即时 delay 会让按总时长的循环真实等待全部时长。
- 健康检查只验证「隧道上取到任何 HTTP 响应」：远端对无凭据 `GET /` 应答 401（index 由 browser-auth 保护），按状态码判定存活会把正常的隧道误判为失败（实际发生过）；pid 存活时 start 复用旧实例，重试连接不会累积 nohup 孤儿进程。
- 同步 MCP / 插件安装写入后依赖远端实例的 HMR 在线应用；实例未运行时，写入的内容在下次启动时生效；宿主未启用 HMR 时需断开重连（重启实例会换 token，不做自动重启）——面板与弹窗不显示关于生效时机的提示。
- `yaml` 是 host half 唯一内联的 node_modules 依赖（`host.bundle: ['yaml']`）；新增运行时依赖须显式进 bundle。
- host half 变更需重启宿主；client half 刷新页面即生效。

## 测试

`pnpm --filter @weilence/dsh-remote test`：launch / patchDoc / connections / shared（一致性谓词与 canonicalJson）/ localenv（技能摘要折叠 + 插件包树指纹与内容寻址命名）纯函数单测；engine.test.ts 用 fake ssh / 转发 / 扫描依赖做全链集成（连接含部署段：tgz 推送与版本对比、token 解析、三类同步——一致跳过 / 覆盖 / 未勾选不动 / 手写行替换 / push 比指纹与 remote 比版本的分流、互斥）；host.test.ts 假 ctx + 临时目录两层 patch 做路由的请求-响应集成测试。
