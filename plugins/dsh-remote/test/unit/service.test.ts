import { describe, expect, it } from 'vitest'
import {
  buildHealthCommand,
  buildLaunchCommand,
  buildPollCommand,
  buildPortProbeCommand,
  buildStopCommand,
  buildUnitContent,
  buildUnitPortProbe,
  PORT_CANDIDATES,
  PREFERRED_PORT,
  UNIT_LOG,
  UNIT_NAME,
  type ServicePaths,
} from '../../src/service'

const paths: ServicePaths = {
  home: '/home/u',
  dshPath: '/usr/local/bin/dsh',
  path: '/home/u/.nvm/versions/node-v22/bin:/usr/local/bin:/usr/bin:/bin',
  port: 3080,
}

const pidFile = '~/.dsh/dsh-remote/dev-box.pid'

describe('单元名与日志路径', () => {
  it('固定为 dsh-web.service / web.log：与连接 id、插件包名无关', () => {
    expect(UNIT_NAME).toBe('dsh-web.service')
    expect(UNIT_LOG).toBe('~/.dsh/dsh-remote/web.log')
  })
})

describe('buildUnitContent', () => {
  const content = buildUnitContent(paths)

  it('Type=exec + 登录 PATH 注入 + dsh 绝对路径启动', () => {
    expect(content).toContain('Type=exec')
    expect(content).toContain(`Environment="PATH=${paths.path}"`)
    expect(content).toContain('ExecStart="/usr/local/bin/dsh" --profile web --no-open --port 3080')
  })

  it('日志走 append 到固定路径，启动前截断旧就绪行', () => {
    expect(content).toContain('StandardOutput=append:/home/u/.dsh/dsh-remote/web.log')
    expect(content).toContain('StandardError=append:/home/u/.dsh/dsh-remote/web.log')
    expect(content).toContain(`ExecStartPre=/bin/sh -c ': > "/home/u/.dsh/dsh-remote/web.log"'`)
  })

  it('描述与日志路径不含连接 id：换别名连不会改写单元内容', () => {
    expect(content).toContain('Description=dsh web instance')
    expect(content).not.toContain('dev-box')
    expect(content).not.toContain('dsh-remote-')
  })

  it('崩溃自动拉起 + 有界收尾 + 开机自启', () => {
    expect(content).toContain('Restart=on-failure')
    expect(content).toContain('RestartSec=5s')
    expect(content).toContain('TimeoutStopSec=15s')
    expect(content).toContain('WantedBy=default.target')
  })

  it('值内的 specifier 前缀 % 与引号反斜杠转义', () => {
    const tricky = buildUnitContent({ home: '/ho me', dshPath: '/op"t/d\\sh', path: '/a%b', port: 3081 })
    expect(tricky).toContain('Environment="PATH=/a%%b"')
    expect(tricky).toContain('ExecStart="/op\\"t/d\\\\sh" --profile web --no-open --port 3081')
    expect(tricky).toContain(`ExecStartPre=/bin/sh -c ': > "/ho me/.dsh/dsh-remote/web.log"'`)
  })
})

describe('buildLaunchCommand', () => {
  const command = buildLaunchCommand(pidFile)

  it('用户总线前置环境 + systemd / loginctl 缺失探测（__NOSYSTEMD__ 显式失败）', () => {
    expect(command).toContain('export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"')
    expect(command).toContain('command -v systemctl')
    expect(command).toContain('command -v loginctl')
    expect(command).toContain('echo __NOSYSTEMD__')
  })

  it('旧 nohup 形态迁移清理：核验 pid 身份后整组杀掉并废弃 pid 文件', () => {
    expect(command).toContain('lp=$(cat ~/.dsh/dsh-remote/dev-box.pid 2>/dev/null);')
    expect(command).toContain('ps -p "$lp" -o command=')
    expect(command).toContain('pkill -P "$lp"')
    expect(command).toContain('kill -9 "$lp"')
    expect(command).toContain('rm -f ~/.dsh/dsh-remote/dev-box.pid;')
  })

  it('单元文件经 stdin 原子落盘：内容一致不重写，变化 mv 后 restart 生效', () => {
    expect(command).toContain('cat > ~/.config/systemd/user/dsh-web.service.tmp-dsh-remote;')
    expect(command).toContain('cmp -s')
    expect(command).toContain(
      'mv -f ~/.config/systemd/user/dsh-web.service.tmp-dsh-remote ~/.config/systemd/user/dsh-web.service;',
    )
    expect(command).toContain('systemctl --user daemon-reload')
    expect(command).toContain('systemctl --user restart dsh-web.service')
  })

  it('enable-linger 并验证（失败 __LINGERFAIL__ 带原因）；用户总线有界重试（__NOBUS__）', () => {
    expect(command).toContain('loginctl enable-linger')
    expect(command).toContain('-p Linger')
    expect(command).toContain('echo __LINGERFAIL__')
    expect(command).toContain('until systemctl --user daemon-reload')
    expect(command).toContain('echo __NOBUS__')
  })

  it('复用判定 = 单元未变更且 is-active；启动失败 __STARTFAIL__ 带 status 尾部', () => {
    expect(command).toContain('[ "$(systemctl --user is-active dsh-web.service 2>/dev/null)" = active ]')
    expect(command).toContain('echo "reuse:$(systemctl --user show -p MainPID --value dsh-web.service')
    expect(command).toContain('echo __STARTFAIL__')
    expect(command).toContain('echo "start:$(systemctl --user show -p MainPID --value dsh-web.service')
  })
})

describe('buildStopCommand', () => {
  const command = buildStopCommand(pidFile)

  it('按单元停止（cgroup 连子进程一起收），失败带 status 尾部', () => {
    expect(command).toContain('systemctl --user stop dsh-web.service;')
    expect(command).toContain('echo __STOPFAIL__')
  })

  it('收尾清旧 pid 文件并截断日志（旧就绪行不得污染下次 poll）', () => {
    expect(command).toContain('rm -f ~/.dsh/dsh-remote/dev-box.pid;')
    expect(command).toContain(': > ~/.dsh/dsh-remote/web.log')
  })
})

describe('buildPollCommand', () => {
  it('远端有界循环 grep 就绪行，pid 取 systemd MainPID', () => {
    const command = buildPollCommand(150, 2)
    expect(command).toContain('for i in $(seq 1 150); do')
    expect(command).toContain(`grep -m1 '^dsh web: ' ~/.dsh/dsh-remote/web.log`)
    expect(command).toContain(
      'echo __PID__"$(systemctl --user show -p MainPID --value dsh-web.service 2>/dev/null || true)"',
    )
    expect(command).toContain('sleep 2;')
    expect(command.endsWith('exit 1')).toBe(true)
  })
})

describe('端口选择', () => {
  it('首选端口是 dsh web 自己的默认端口，候选表紧随其后', () => {
    expect(PREFERRED_PORT).toBe(3080)
    expect(PORT_CANDIDATES).toEqual([3080, 3081, 3082, 3083, 3084, 3085, 3086, 3087, 3088, 3089])
  })

  it('buildPortProbeCommand：node 试绑候选表，输出 __PORT__ 标记行', () => {
    const command = buildPortProbeCommand([3080, 3081])
    expect(command).toContain('node -e ')
    expect(command).toContain('const ports=[3080,3081];')
    expect(command).toContain('s.listen(p,"127.0.0.1"')
    expect(command).toContain('console.log("__PORT__"+got)')
    // 候选全占用时退回内核分配（bind(0)）
    expect(command).toContain('const got=await bind(0);console.log("__PORT__"+got)')
  })

  it('buildUnitPortProbe：从既有单元里读 --port，读不到输出空串', () => {
    const command = buildUnitPortProbe()
    expect(command).toContain('echo __UNITPORT__')
    expect(command).toContain('~/.config/systemd/user/dsh-web.service')
    expect(command).toContain('head -n 1')
  })
})

describe('buildHealthCommand', () => {
  it('只读核实：ActiveState / SubState / NRestarts + 日志尾部压平', () => {
    const command = buildHealthCommand()
    expect(command).toContain('command -v systemctl')
    expect(command).toContain(
      'echo __ACTIVE__"$(systemctl --user show -p ActiveState --value dsh-web.service',
    )
    expect(command).toContain('echo __SUB__"$(systemctl --user show -p SubState --value dsh-web.service')
    expect(command).toContain(
      'echo __RESTARTS__"$(systemctl --user show -p NRestarts --value dsh-web.service',
    )
    expect(command).toContain('echo __LOG__"$(tail -n 6 ~/.dsh/dsh-remote/web.log')
    expect(command).not.toContain('systemctl --user restart')
    expect(command).not.toContain('systemctl --user start')
    expect(command).not.toContain('systemctl --user stop')
  })
})
