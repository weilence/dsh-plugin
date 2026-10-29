/** ssh 调用参数矩阵 + 口令通道（SSH_ASKPASS 预载 hook）+ 失败分类。 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildForwardArgs,
  buildSshInvocation,
  classifySshFailure,
  createAskpass,
  SshFailure,
  type Askpass,
  type SshTarget,
} from '../../src/ssh'
import type { ConnectionTarget } from '../../src/shared'

const askpass: Askpass = {
  env: (secret) => ({ DSH_REMOTE_SSH_SECRET: secret }),
  ensure: async () => {},
}

const alias = (name: string): SshTarget => ({ target: { kind: 'alias', alias: name }, secret: null })

const direct = (auth: 'key' | 'password'): ConnectionTarget => ({
  kind: 'direct',
  host: '10.0.0.5',
  port: 2222,
  user: 'root',
  auth,
  identityFile: auth === 'key' ? '/keys/id_ed25519' : null,
})

describe('buildSshInvocation', () => {
  it('别名：BatchMode + -- 终止选项，认证完全交给 ssh config', () => {
    const invocation = buildSshInvocation(alias('dev-box'), askpass)
    expect(invocation.args).toEqual(['-o', 'BatchMode=yes', '--', 'dev-box'])
    expect(invocation.env).toBeNull()
  })

  it('密钥（无口令）：BatchMode 快速失败、锁死只用指定密钥', () => {
    const invocation = buildSshInvocation({ target: direct('key'), secret: null }, askpass)
    expect(invocation.args).toEqual([
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-p',
      '2222',
      '-l',
      'root',
      '-i',
      '/keys/id_ed25519',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'PreferredAuthentications=publickey',
      '-o',
      'BatchMode=yes',
      '--',
      '10.0.0.5',
    ])
    expect(invocation.env).toBeNull()
  })

  it('密钥（有口令）：去掉 BatchMode（否则 ssh 不会提问），口令走 askpass', () => {
    const invocation = buildSshInvocation({ target: direct('key'), secret: 'phrase' }, askpass)
    expect(invocation.args).not.toContain('BatchMode=yes')
    expect(invocation.args).toContain('NumberOfPasswordPrompts=1')
    expect(invocation.args.at(-1)).toBe('10.0.0.5')
    expect(invocation.args.slice(-3)).toEqual(['NumberOfPasswordPrompts=1', '--', '10.0.0.5'])
    expect(invocation.env).toEqual({ DSH_REMOTE_SSH_SECRET: 'phrase' })
  })

  it('密码：不走公钥、不设 BatchMode、重试一次，主机密钥 accept-new', () => {
    const invocation = buildSshInvocation({ target: direct('password'), secret: 'pw' }, askpass)
    expect(invocation.args).toEqual([
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-p',
      '2222',
      '-l',
      'root',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'NumberOfPasswordPrompts=1',
      '--',
      '10.0.0.5',
    ])
    expect(invocation.env).toEqual({ DSH_REMOTE_SSH_SECRET: 'pw' })
  })

  it('密码登录没有口令：显式报错（不构造一次注定失败的认证）', () => {
    expect(() => buildSshInvocation({ target: direct('password'), secret: null }, askpass)).toThrow(
      SshFailure,
    )
  })

  it('转发参数插在目标之前（-N -L 仍会被识别）', () => {
    const invocation = buildSshInvocation(alias('dev-box'), askpass, [
      '-N',
      '-L',
      '127.0.0.1:19999:127.0.0.1:4321',
    ])
    expect(invocation.args).toEqual([
      '-o',
      'BatchMode=yes',
      '-N',
      '-L',
      '127.0.0.1:19999:127.0.0.1:4321',
      '--',
      'dev-box',
    ])
  })

  it('buildForwardArgs：ExitOnForwardFailure 让绑不上本地口立即退出（引擎据此换口重试）', () => {
    expect(buildForwardArgs(19999, 4321)).toEqual([
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      '127.0.0.1:19999:127.0.0.1:4321',
    ])
  })
})

describe('classifySshFailure', () => {
  it('主机密钥变更单列 host-key（不误报成认证失败）', () => {
    const failure = classifySshFailure(
      255,
      '@@@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@@@\nHost key verification failed.',
    )
    expect(failure.kind).toBe('host-key')
    expect(failure.detail).toContain('REMOTE HOST IDENTIFICATION')
  })

  it('认证失败给出覆盖三种登录方式的指引', () => {
    const failure = classifySshFailure(255, 'root@10.0.0.5: Permission denied (publickey,password).')
    expect(failure.kind).toBe('auth-failed')
    expect(failure.message).toContain('密码')
  })

  it('不可达 / 本机缺 ssh / 命令失败各自分类', () => {
    expect(
      classifySshFailure(255, 'ssh: Could not resolve hostname nope: Name or service not known').kind,
    ).toBe('unreachable')
    expect(classifySshFailure(null, '', { code: 'ENOENT' } as NodeJS.ErrnoException).kind).toBe(
      'local-tool-missing',
    )
    expect(classifySshFailure(1, 'rm: cannot remove').kind).toBe('remote-cmd-failed')
  })

  it('本机 ssh 客户端横幅不污染错误摘要', () => {
    const failure = classifySshFailure(
      1,
      '** WARNING: connection is not using a post-quantum key exchange algorithm. **\nreal error line',
    )
    expect(failure.message).toContain('real error line')
    expect(failure.message).not.toContain('post-quantum')
  })
})

describe('createAskpass', () => {
  const dirs: string[] = []

  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  it('环境变量：宿主可执行文件 + --require 预载 hook（正斜杠路径）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-remote-askpass-'))
    dirs.push(home)
    const channel = createAskpass(home)
    const env = channel.env('pw')
    expect(env.SSH_ASKPASS).toBe(process.execPath)
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.DSH_REMOTE_SSH_SECRET).toBe('pw')
    expect(env.NODE_OPTIONS).toContain('--require')
    expect(env.NODE_OPTIONS).not.toContain('\\')
    expect(env.NODE_OPTIONS).toContain('askpass.cjs')
  })

  it('hook 写盘 + 自检：宿主可执行文件以 Node 模式回传口令', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-remote askpass space-'))
    dirs.push(home)
    await createAskpass(home).ensure()
    const hook = await readFile(join(home, 'dsh-remote', 'askpass.cjs'), 'utf8')
    expect(hook).toContain('DSH_REMOTE_SSH_SECRET')
    // 二次 ensure 走缓存，仍不抛
    await createAskpass(home).ensure()
  })
})
