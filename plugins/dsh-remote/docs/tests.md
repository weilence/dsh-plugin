# dsh-remote 测试地图

本文件承载本插件的测试地图：每个测试文件覆盖什么、单测 / 集成如何运行；单测与集成的划分判据（是否 spawn 真外部进程 / 走真 socket）、默认只跑单测与集成手动执行的时机见[根 docs/testing.md](../../../docs/testing.md)「测试约定」。

## 如何运行

- 单测：`pnpm --filter @weilence/dsh-remote test`（默认，跑 `test/unit/`；四项检查随之只覆盖单测）。
- 集成（手动）：`pnpm --filter @weilence/dsh-remote test:integration`，现仅 `test/integration/pack.test.ts` 真 pnpm pack；重要改动与发版前应跑一遍。

## 单测（test/unit/）

- `launch.test.ts`：`dsh web:` 启动行的宽松解析。
- `patchDoc.test.ts`：两层 patch 层扫描（insert 行读取）。
- `shared.test.ts`：一致性谓词与 canonicalJson；`compareDshVersion` 的 semver 序（prerelease 逐标识、前导 v 与 build 元数据不参与、畸形回 null）与 `dshDrift` 三态；`preferredLocalTunnelPort` 的推导稳定性 / 段位 / 散布。
- `localenv.test.ts`：技能摘要折叠（`foldSkillDigest`）。
- `localproc.test.ts`：`decodeLocalOutput`（win32 + 936 的 GBK 字节解出原文、UTF-8 不被回退误转、65001 / 未知 / null 码页保持 UTF-8、非 win32 不回退）；`codepageLabel` 常见码页映射与 65001 / 未知归 null；`parseCodepageOutput` 从 chcp 本地化输出解析数字（无数字 / 空回 null）；`resolveWindowsCommand` 目录优先于扩展名、跳过缺失项与空目录段、全缺回 null；`resolveWindowsPnpm` 按 PATH 找绝对路径、找不到 / PATH 缺失回 null。
- `service.test.ts`：单元内容与启动 / 停止 / 轮询 / 端口探测 / 端口读取 / 存活核实命令的确定性文本断言——Type=exec、登录 PATH 注入、显式 --port、% 与引号转义、标记行、候选端口表、核实命令只读不 start/restart/stop。
- `sshconfig.test.ts`：Host 字段、通配与 Match 截断、同名合并、Include 展开与环、缺失文件。
- `ssh.test.ts`：`buildSshInvocation` 的三种目标与转发参数；`buildForwardArgs` 含 ExitOnForwardFailure 与 ServerAlive 保活；口令场景无 BatchMode；失败分类含 host-key；askpass 环境与 hook 自检真跑子进程。
- `connections.test.ts`：目标校验（地址 / 端口 / 用户 / 密钥文件存在性）；口令落点规则（记住 / 会话 / 清除 / 切认证方式不沿用）；v1 迁移与 0600 写盘；`toRemoteConnection` 脱敏。
- `transport.test.ts`：`RemoteTransportService` 以正式 Cordis 服务 + 真本地 http server 走启动 token 换 Cookie 的完整请求链——同 authority Cookie 与 `x-dsh-sessions` 等请求头、连接清单的 disconnected / busy / connecting / error / probing 区分、运行时拒绝任意路径与未确认隧道 URL、认证失败（401 / 500 / 302）不跟随跳转、Cookie 不跨 authority 且不缓存不串用、传输期间连接变化（断开 / pid 变 / token 变）与插件卸载后拒发、保留远端错误而拒绝非 JSON 与接口跳转、响应长度与流式累积上限、网络错误剔除 token、非对象 JSON 拒绝、无效 Cookie / 跳转拒绝、POST 发出后未知结果提醒重新预览、认证与响应链路同一超时、清单与错误详情不泄露 token / Cookie。
- `forwards.test.ts`：租约读写与 sweep 三态；遗留核验真跑子进程（假 ssh 可执行文件：本插件形态杀、端口不符与无关进程不误杀；Windows 跳过）。
- `probe.test.ts`：`parseToolProbe` 的探查合并输出解析——三个工具齐全时拿到各自版本、工具缺失时对应字段为 null（错误文本不冒充版本）、输出畸形（无标记行 / 空输出）按整体不可用处理。
- `pack.test.ts`：`packPackage` 的 pnpm 解析口径——win32 解析不到 pnpm 时抛可读的显式错误、不经 shell（端到端打包语义由集成的 `pack.test.ts` 真 pnpm 覆盖）。
- `engine.test.ts`：用 fake ssh / 转发 / 扫描依赖做全链集成——
  - 连接含部署段：tgz 推送与版本对比、token 解析；systemd 启动段——单元 stdin 落盘断言 / 无 systemctl、linger 失败、总线不可达、start 失败的分类报错（无 nohup 回退）/ 服务事实缺失部署段中止。
  - 实例版本判定组：复用直连 / 自报版本落后回环 systemctl stop / 旧插件 404 回环 / 非 404 失败显式报错不盲目重启 / 重启后仍不匹配只回环一次 / 复用实例健康检查不过自愈回环。
  - 版本漂移与手动升级组：部署段远端较新不降级（无 npm install、machine.dsh 记远端实际值、step dsh-newer）/ 远端较旧（含 prerelease 序）npm 装目标版本 / 实例自报新于目标不经 stop 直接接受并种下 local-behind / 心跳漂移实时刷新（落后显形、追平清空）与本机现读升级（fake 可变的 `setCurrentDsh`）/ startUpgradeRemote 完整升级流（装新版本、旧实例 stop 收敛、回 running、progress.kind=upgrade）/ 升级失败 error / 互斥与缺口令。
  - 四类同步：提交即执行（已一致项勾选即强制重推——skills 全量 tar / MCP 条目合并（同名覆盖、远端独有条目与顶层键保留、结构坏显式中止）/ 插件已一致仍打包推送或精确下载 / 提示词强制重写，未勾选不动不删除）；互斥；运行中同步失败不丢连接。
  - 端口选择与本地隧道组：单元无端口时探测写入（`__PORT__`）/ 探测失败显式报错 / 单元端口与实际监听不一致以实际建隧道并记 port-drift / EADDRINUSE 超时指明端口冲突；首选口空闲即用（隧道与租约同口）/ 被占回退临时口 / 竞态抢占（进程即死）换口重试一次 / 临时口也绑不上显式报错不重启远端 / 转发活着但不通走自愈不换口。
  - 心跳组（`fakeClock` 推进假时钟驱动 `heartbeat()`）：健康不动作不建连 / 每拍顺路问 /version 刷新实例自报身份（展示实时、不触发动作）/ 10s 节流与 3 次判死阈值 / active → 无响应保留隧道退避 60s / activating → 重启中不动手 / inactive → 自动收敛走全流程回 running（op=recover）/ 收敛失败 error（progress.kind=recover）/ 收敛 3 次超限判死 / 核实 ssh 失败 unknown 不动作。
  - 转发中断自动重连组：中断自动重连回 running（op=reconnect、租约重录）/ 重试耗尽 error（progress.kind=reconnect、2 次 retry + retry-exhausted 步骤、保留最后一轮具体原因）/ 风暴抑制（窗口内第 4 次死亡停手不建连）/ 死亡间隔超窗口计数复位 / 手动连接重置风暴计数。
  - 其他：转发租约落盘与删除清除与 load 清扫；`probe` 无状态与三段版本；会话口令三态与重启后补录；真 `bash -n` 语法校验全部远端命令——join 拼接缺分号只在真 shell 暴露，mock 全绿不等于命令合法；mock 按命令子串（`__NODE__` / `grep -m1` / `is-active` / `systemctl --user stop`）区分。
- `client-store.test.ts`：op 迁移检测的事件 toast（自动恢复 / 自动重连、同步完成与失败摘要；用户发起的连接 / 升级完成与写操作不投递 toast）；表单测试结果落 `testResult` 行内；口令弹窗门控与补录后续动作（连接 / 同步 / 升级三入口）；ssh config 懒加载；面板关闭边界（跨关闭窗口完成的连接迁移、关闭期间完成的同步与关闭瞬间在途的 refresh 都不补发 toast）。
- `sync-view.test.ts`：SyncDialog 的 rowsOf 投影。
- `panel.test.tsx`：面板渲染文本；三段登录表单与口令状态；补录弹窗；事件 toast 经 `store.toasts` 投递而面板内不渲染；表单测试结果行内；版本漂移徽标与升级入口 / 确认弹窗；心跳结论替代「运行中」pill 与异常时的「重新连接」入口；宿主语言切换。
- `host.test.ts`：假 ctx + 临时目录两层 patch 与 mcp.json 做路由的请求-响应集成测试（含 `/test` 无状态探针、`/upgrade` 与 connect 同构的状态码、缺口令 409、`/secret` 只进内存、`/ssh-hosts` 形状）。

## 集成（test/integration/，手动运行）

- `pack.test.ts`：真跑 `pnpm pack` 校验产物命名与错误上抛（Windows / 无 pnpm 跳过）。

## 测试辅助

- `i18n.ts`：单测取词辅助 `makeT`（与宿主同一种插值语义，含 common 词条快照），非测试文件。
