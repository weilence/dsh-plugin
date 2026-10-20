/** ~/.ssh/config 的只读扫描：字段提取、通配跳过、Match 截断、Include 展开。 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSshConfig, readSshConfig } from '../src/sshconfig'

const posix = (path: string): string => path.replaceAll('\\', '/')

describe('parseSshConfig', () => {
  it('提取 Host / HostName / User / Port / IdentityFile / ProxyJump，注释与大小写不敏感', () => {
    const hosts = parseSshConfig(
      [
        '# 顶部注释',
        'Host dev',
        '  HostName 10.0.0.5   # 行尾注释',
        '  user root',
        '  PORT 2222',
        '  IdentityFile ~/.ssh/id_ed25519',
        '  ProxyJump bastion',
        '',
        'Host=eq',
        '  HostName eq.example.com',
      ].join('\n'),
    )
    expect(hosts).toEqual([
      {
        alias: 'dev',
        hostname: '10.0.0.5',
        user: 'root',
        port: 2222,
        identityFile: '~/.ssh/id_ed25519',
        proxy: 'bastion',
      },
      {
        alias: 'eq',
        hostname: 'eq.example.com',
        user: null,
        port: null,
        identityFile: null,
        proxy: null,
      },
    ])
  })

  it('一个 Host 行多个别名共享声明；通配段与否定段整段跳过', () => {
    const hosts = parseSshConfig(
      [
        'Host web1 web2',
        '  User deploy',
        'Host *.internal',
        '  User wildcard',
        'Host !blocked',
        '  User negative',
        'Host app.internal',
        '  User literal',
      ].join('\n'),
    )
    expect(hosts.map((host) => host.alias)).toEqual(['app.internal', 'web1', 'web2'])
    expect(hosts[1]).toMatchObject({ user: 'deploy' })
    expect(hosts[2]).toMatchObject({ user: 'deploy' })
    expect(hosts[0]).toMatchObject({ user: 'literal' })
  })

  it('Match 之后的字段不再属于上一个 Host 段', () => {
    const hosts = parseSshConfig(
      ['Host first', '  User a', 'Match host x', '  User b', 'Host second', '  User c'].join('\n'),
    )
    expect(hosts.find((host) => host.alias === 'first')).toMatchObject({ user: 'a' })
    expect(hosts.find((host) => host.alias === 'second')).toMatchObject({ user: 'c' })
  })

  it('同名别名多段：逐字段首次取值（后段只补空缺）', () => {
    const hosts = parseSshConfig(
      ['Host dup', '  User first', 'Host dup', '  HostName second.example', '  User ignored'].join('\n'),
    )
    expect(hosts).toEqual([
      {
        alias: 'dup',
        hostname: 'second.example',
        user: 'first',
        port: null,
        identityFile: null,
        proxy: null,
      },
    ])
  })

  it('按别名排序；无效端口不写入展示值', () => {
    const hosts = parseSshConfig(['Host z', 'Host a', 'Host b', '  Port nope'].join('\n'))
    expect(hosts.map((host) => host.alias)).toEqual(['a', 'b', 'z'])
    expect(hosts[1]?.port).toBeNull()
  })
})

describe('readSshConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-sshconfig-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('缺失文件：exists=false、无错误', async () => {
    const response = await readSshConfig(join(dir, 'nope'))
    expect(response).toEqual({ path: join(dir, 'nope'), exists: false, hosts: [], error: null })
  })

  it('Include 按位置展开（绝对路径 + glob），文件缺失记入 error', async () => {
    const includeDir = join(dir, 'conf.d')
    await mkdir(includeDir, { recursive: true })
    await writeFile(join(includeDir, 'a.conf'), 'Host from-a\n  User ua\n', 'utf8')
    await writeFile(join(includeDir, 'b.conf'), 'Host from-b\n  HostName b.example\n', 'utf8')
    const config = [
      'Host before',
      '  User ub',
      `Include ${posix(join(includeDir, '*.conf'))}`,
      `Include ${posix(join(dir, 'missing.conf'))}`,
      'Host after',
      '  User ua2',
    ].join('\n')
    await writeFile(join(dir, 'config'), config, 'utf8')

    const response = await readSshConfig(join(dir, 'config'))
    expect(response.exists).toBe(true)
    expect(response.hosts.map((host) => host.alias)).toEqual(['after', 'before', 'from-a', 'from-b'])
    expect(response.error).toContain('missing.conf')
  })

  it('Include 循环有界终止并说明原因', async () => {
    const a = join(dir, 'a.conf')
    const b = join(dir, 'b.conf')
    await writeFile(a, `Host a\n  User ua\nInclude ${posix(b)}\n`, 'utf8')
    await writeFile(b, `Host b\n  User ub\nInclude ${posix(a)}\n`, 'utf8')
    const configPath = join(dir, 'config')
    await writeFile(configPath, `Include ${posix(a)}\n`, 'utf8')

    const response = await readSshConfig(configPath)
    expect(response.hosts.map((host) => host.alias)).toEqual(['a', 'b'])
    expect(response.error).toContain('循环')
  })

  it('Include 里的 Host 段接续在当前块之后（不被前一 Host 吞掉）', async () => {
    const included = join(dir, 'extra.conf')
    await writeFile(included, 'Host included\n  HostName inc.example\n', 'utf8')
    const configPath = join(dir, 'config')
    await writeFile(configPath, `Host outer\n  User uo\nInclude ${posix(included)}\n`, 'utf8')

    const response = await readSshConfig(configPath)
    expect(response.hosts.map((host) => host.alias)).toEqual(['included', 'outer'])
    expect(response.hosts[1]?.user).toBe('uo')
  })
})
