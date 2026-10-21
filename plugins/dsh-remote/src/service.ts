/**
 * systemd 托管远端实例的装配层：单元文件内容与启动/停止/轮询远端命令全部
 * 在本机构建成确定性字符串（单测直接断言文本），执行侧（engine）只吃成品
 * 并解析输出。远端实例由 systemd 用户单元托管——开机自启（enable-linger）、
 * 崩溃自动拉起（Restart=on-failure）、cgroup 级子进程回收，不再有 nohup 裸
 * 进程；远端缺 systemctl / 用户总线 / linger 任一环即显式报错，无回退。
 */

/** 远端服务事实（部署段探查产物）：unit 内容的原料。 */
export interface ServicePaths {
  /** 远端用户 home 绝对路径（探查时 $HOME）。 */
  home: string
  /** dsh 可执行文件绝对路径（command -v dsh）。 */
  dshPath: string
  /** 远端登录 shell 的 PATH——unit 的 Environment=PATH= 整体替换用它：systemd
   *  用户管理器的默认 PATH 极简，nvm 的 node、MCP server 的 uv/npx 等裸命令
   *  全靠登录 PATH 解析。每次连接重探重写 unit，内容变化经 cmp 检出后 restart。 */
  path: string
}

/** 远端实例的 systemd 用户单元名：一台机器只有一个远端实例，单元名固定。 */
export const UNIT_NAME = 'dsh-web.service'

/** 远端实例日志路径（~ 形态，远端 shell 内展开）。与单元名一样固定——日志
 *  路径若随本地连接 id 变化，同一台机器换个别名连就会改写单元内容并互相
 *  restart。 */
export const UNIT_LOG = '~/.dsh/dsh-remote/web.log'

/** 单元文件内的 % 转义（% 是 systemd specifier 前缀）。 */
function escapeSpec(text: string): string {
  return text.replace(/%/g, '%%')
}

/** 双引号包裹值内的转义（\ 与 " 先于 % 转义）。 */
function escapeQuoted(text: string): string {
  return escapeSpec(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 组装 systemd 用户单元内容。要点：
 *  - Type=exec：start 在 exec() 成功后才返回，MainPID 无竞态（要求 systemd ≥ 240）；
 *  - 登录 PATH 整体注入：dsh 的 `#!/usr/bin/env node` shebang 与 MCP server 的
 *    裸命令（uvx / npx）都按它解析；
 *  - ExecStartPre 截断日志：重启（含 Restart= 自动拉起）先清旧就绪行，poll
 *    不会命中死实例的旧 token；停止侧（engine stopInstance）再截一次兜底；
 *  - StandardOutput/StandardError append 到既有日志路径：launch.ts 的就绪行
 *    解析与失败时的日志尾部读取保持不变；
 *  - TimeoutStopSec 有界收尾（MCP server 挨个退），对齐旧实现 10s 等待语义。
 *  Description 与日志路径都不含连接 id：单元内容只随机器实况（dsh 路径 /
 *  登录 PATH）变化，同一台机器换别名连不会触发重写与 restart。 */
export function buildUnitContent(paths: ServicePaths): string {
  const logPath = `${paths.home}/.dsh/dsh-remote/web.log`
  const lines = [
    '[Unit]',
    'Description=dsh web instance',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=exec',
    `Environment="PATH=${escapeQuoted(paths.path)}"`,
    `ExecStart="${escapeQuoted(paths.dshPath)}" --profile web --no-open --port 0`,
    `ExecStartPre=/bin/sh -c ': > "${escapeQuoted(logPath)}"'`,
    `StandardOutput=append:${escapeSpec(logPath)}`,
    `StandardError=append:${escapeSpec(logPath)}`,
    'Restart=on-failure',
    'RestartSec=5s',
    'TimeoutStopSec=15s',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ]
  return lines.join('\n')
}

/** systemd 用户总线的前置环境：ssh 非交互会话通常由 pam_systemd 注入
 *  XDG_RUNTIME_DIR，缺失时按 uid 补——`systemctl --user` 找不到运行时目录
 *  会以 "Failed to connect to bus" 失败，而非缺 linger 的可读原因。 */
const BUS_ENV = `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"`

/** 启动命令（stdin = 单元文件内容）：探测 systemd 可用性 → 迁移清理旧 nohup
 *  实例 → 原子落盘 unit（内容不变不重写）→ enable-linger 并验证 → 用户总线
 *  就绪（daemon-reload 有界重试，覆盖 linger 刚开启管理器未起完的窗口）→
 *  enable + 复用或重启。失败经标记行输出，engine 按 markedValues 分类报错：
 *  __NOSYSTEMD__ / __LINGERFAIL__<err> / __NOBUS__<err> / __STARTFAIL__<status>；
 *  成功输出 `reuse:<pid>`（unit 未变且已 active）或 `start:<pid>`。
 *  pidFile 是旧 nohup 形态的遗留路径（按连接 id 命名）：升级插件后首次连接
 *  先核验身份杀掉旧进程，否则新单元与旧裸进程会各占一个端口悄悄分裂。 */
export function buildLaunchCommand(pidFile: string): string {
  const unitPath = `~/.config/systemd/user/${UNIT_NAME}`
  const tmp = `${unitPath}.tmp-dsh-remote`
  return [
    `${BUS_ENV};`,
    `command -v systemctl >/dev/null 2>&1 || { echo __NOSYSTEMD__; exit 0; };`,
    `command -v loginctl >/dev/null 2>&1 || { echo __NOSYSTEMD__; exit 0; };`,
    `mkdir -p ~/.config/systemd/user ~/.dsh/dsh-remote;`,
    // 旧 nohup 形态迁移清理：pid 文件核验身份后杀（防单元与新实例叠加双实例），
    // 然后废弃 pid 文件——存活判定自此只认 systemctl
    `lp=$(cat ${pidFile} 2>/dev/null);`,
    `if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null && ps -p "$lp" -o command= 2>/dev/null | grep -q dsh; then kill "$lp"; pkill -P "$lp" 2>/dev/null; for i in $(seq 1 10); do kill -0 "$lp" 2>/dev/null || break; sleep 1; done; kill -9 "$lp" 2>/dev/null; fi;`,
    `rm -f ${pidFile};`,
    `cat > ${tmp};`,
    `if cmp -s ${tmp} ${unitPath}; then rm -f ${tmp}; else mv -f ${tmp} ${unitPath}; changed=1; fi;`,
    `lingerErr=$(loginctl enable-linger 2>&1) || true;`,
    `lingerState=$(loginctl show-user "$(id -u)" -p Linger --value 2>/dev/null || loginctl show-user "$(id -u)" -p Linger 2>/dev/null);`,
    `case "$lingerState" in *yes*) ;; *) echo __LINGERFAIL__"$lingerErr"; exit 0;; esac;`,
    `i=0; until systemctl --user daemon-reload >/dev/null 2>&1; do i=$((i+1)); if [ "$i" -ge 10 ]; then echo __NOBUS__"$(systemctl --user daemon-reload 2>&1)"; exit 0; fi; sleep 1; done;`,
    `systemctl --user enable ${UNIT_NAME} >/dev/null 2>&1 || true;`,
    `if [ "$changed" != 1 ] && [ "$(systemctl --user is-active ${UNIT_NAME} 2>/dev/null)" = active ]; then echo "reuse:$(systemctl --user show -p MainPID --value ${UNIT_NAME} 2>/dev/null)"; exit 0; fi;`,
    `systemctl --user reset-failed ${UNIT_NAME} >/dev/null 2>&1 || true;`,
    `if ! systemctl --user restart ${UNIT_NAME} >/dev/null 2>&1; then echo __STARTFAIL__"$(systemctl --user status ${UNIT_NAME} 2>&1 | tail -n 12)"; exit 1; fi;`,
    `echo "start:$(systemctl --user show -p MainPID --value ${UNIT_NAME} 2>/dev/null)"`,
  ].join(' ')
}

/** 停止命令：systemd 按单元（cgroup）杀整组进程，无 pid 身份核验与 pkill
 *  补杀的必要；失败带 status 尾部便于定位。收尾仍清旧 pid 文件并截断日志
 *  ——旧就绪行不清，下次 poll 会秒命中死实例的旧 token。 */
export function buildStopCommand(pidFile: string): string {
  return [
    `${BUS_ENV};`,
    `command -v systemctl >/dev/null 2>&1 || { echo __NOSYSTEMD__; exit 0; };`,
    `systemctl --user stop ${UNIT_NAME};`,
    `rc=$?;`,
    `if [ "$rc" -ne 0 ]; then echo __STOPFAIL__"$(systemctl --user status ${UNIT_NAME} 2>&1 | tail -n 12)"; exit "$rc"; fi;`,
    `rm -f ${pidFile};`,
    `: > ${UNIT_LOG} 2>/dev/null || true`,
  ].join(' ')
}

/** 就绪轮询命令：既有形态不变（远端有界循环 grep 就绪行），仅 pid 来源从
 *  pid 文件换成 systemctl 的 MainPID（同一连接输出 `__PID__<值>`）。 */
export function buildPollCommand(maxAttempts: number, intervalSeconds: number): string {
  return [
    `${BUS_ENV};`,
    `for i in $(seq 1 ${maxAttempts}); do`,
    `line=$(grep -m1 '^dsh web: ' ${UNIT_LOG} 2>/dev/null) && { echo "$line";`,
    `echo __PID__"$(systemctl --user show -p MainPID --value ${UNIT_NAME} 2>/dev/null || true)"; exit 0; };`,
    `sleep ${intervalSeconds};`,
    'done;',
    'exit 1',
  ].join(' ')
}
