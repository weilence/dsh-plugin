import { describe, expect, it } from 'vitest'
import {
  buildLaunchCommand,
  buildPollCommand,
  buildStopCommand,
  buildUnitContent,
  unitName,
  type ServicePaths,
} from '../src/service'

const paths: ServicePaths = {
  home: '/home/u',
  dshPath: '/usr/local/bin/dsh',
  path: '/home/u/.nvm/versions/node-v22/bin:/usr/local/bin:/usr/bin:/bin',
}

const files = {
  unit: 'dsh-remote-dev-box.service',
  log: '~/.dsh/dsh-remote/dev-box.log',
  pidFile: '~/.dsh/dsh-remote/dev-box.pid',
}

describe('unitName', () => {
  it('常规 id 直拼；含不安全字符的 id 清洗并补哈希段（确定性且单元名安全）', () => {
    expect(unitName('dev-box')).toBe('dsh-remote-dev-box.service')
    const weird = unitName('my host/prod:1')
    expect(weird).toMatch(/^dsh-remote-[A-Za-z0-9@._-]+\.service$/)
    expect(weird).toBe(unitName('my host/prod:1'))
    // 不同 id 清洗后不撞名（哈希段区分）
    expect(unitName('a b')).not.toBe(unitName('a_b'))
  })
})

describe('buildUnitContent', () => {
  const content = buildUnitContent({
    id: 'dev-box',
    paths,
    logPath: '/home/u/.dsh/dsh-remote/dev-box.log',
  })

  it('Type=exec + 登录 PATH 注入 + dsh 绝对路径启动', () => {
    expect(content).toContain('Type=exec')
    expect(content).toContain(`Environment="PATH=${paths.path}"`)
    expect(content).toContain('ExecStart="/usr/local/bin/dsh" --profile web --no-open --port 0')
  })

  it('日志走 append 到既有路径，启动前截断旧就绪行', () => {
    expect(content).toContain('StandardOutput=append:/home/u/.dsh/dsh-remote/dev-box.log')
    expect(content).toContain('StandardError=append:/home/u/.dsh/dsh-remote/dev-box.log')
    expect(content).toContain(`ExecStartPre=/bin/sh -c ': > "/home/u/.dsh/dsh-remote/dev-box.log"'`)
  })

  it('崩溃自动拉起 + 有界收尾 + 开机自启', () => {
    expect(content).toContain('Restart=on-failure')
    expect(content).toContain('RestartSec=5s')
    expect(content).toContain('TimeoutStopSec=15s')
    expect(content).toContain('WantedBy=default.target')
  })

  it('值内的 specifier 前缀 % 与引号反斜杠转义', () => {
    const tricky = buildUnitContent({
      id: 'dev%box',
      paths: { home: '/ho me', dshPath: '/op"t/d\\sh', path: '/a%b' },
      logPath: '/ho me/.dsh/log',
    })
    expect(tricky).toContain('Description=dsh web instance (dsh-remote dev%%box)')
    expect(tricky).toContain('Environment="PATH=/a%%b"')
    expect(tricky).toContain('ExecStart="/op\\"t/d\\\\sh"')
    expect(tricky).toContain(`ExecStartPre=/bin/sh -c ': > "/ho me/.dsh/log"'`)
  })
})

describe('buildLaunchCommand', () => {
  const command = buildLaunchCommand(files)

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
    expect(command).toContain('cat > ~/.config/systemd/user/dsh-remote-dev-box.service.tmp-dsh-remote;')
    expect(command).toContain('cmp -s')
    expect(command).toContain(
      `mv -f ~/.config/systemd/user/dsh-remote-dev-box.service.tmp-dsh-remote ~/.config/systemd/user/dsh-remote-dev-box.service;`,
    )
    expect(command).toContain('systemctl --user daemon-reload')
    expect(command).toContain('systemctl --user restart dsh-remote-dev-box.service')
  })

  it('enable-linger 并验证（失败 __LINGERFAIL__ 带原因）；用户总线有界重试（__NOBUS__）', () => {
    expect(command).toContain('loginctl enable-linger')
    expect(command).toContain('-p Linger')
    expect(command).toContain('echo __LINGERFAIL__')
    expect(command).toContain('until systemctl --user daemon-reload')
    expect(command).toContain('echo __NOBUS__')
  })

  it('复用判定 = 单元未变更且 is-active；启动失败 __STARTFAIL__ 带 status 尾部', () => {
    expect(command).toContain(
      `[ "$(systemctl --user is-active dsh-remote-dev-box.service 2>/dev/null)" = active ]`,
    )
    expect(command).toContain(
      'echo "reuse:$(systemctl --user show -p MainPID --value dsh-remote-dev-box.service',
    )
    expect(command).toContain('echo __STARTFAIL__')
    expect(command).toContain(
      'echo "start:$(systemctl --user show -p MainPID --value dsh-remote-dev-box.service',
    )
  })
})

describe('buildStopCommand', () => {
  const command = buildStopCommand(files)

  it('按单元停止（cgroup 连子进程一起收），失败带 status 尾部', () => {
    expect(command).toContain('systemctl --user stop dsh-remote-dev-box.service;')
    expect(command).toContain('echo __STOPFAIL__')
  })

  it('收尾清旧 pid 文件并截断日志（旧就绪行不得污染下次 poll）', () => {
    expect(command).toContain('rm -f ~/.dsh/dsh-remote/dev-box.pid;')
    expect(command).toContain(': > ~/.dsh/dsh-remote/dev-box.log')
  })
})

describe('buildPollCommand', () => {
  it('远端有界循环 grep 就绪行，pid 取 systemd MainPID', () => {
    const command = buildPollCommand(files, 150, 2)
    expect(command).toContain('for i in $(seq 1 150); do')
    expect(command).toContain(`grep -m1 '^dsh web: ' ~/.dsh/dsh-remote/dev-box.log`)
    expect(command).toContain(
      'echo __PID__"$(systemctl --user show -p MainPID --value dsh-remote-dev-box.service 2>/dev/null || true)"',
    )
    expect(command).toContain('sleep 2;')
    expect(command.endsWith('exit 1')).toBe(true)
  })
})
