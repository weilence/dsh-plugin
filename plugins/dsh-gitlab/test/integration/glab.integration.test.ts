/** 真进程 spawn：stub glab 脚本走 env 注入 / argv / cwd / 超时 / 截断 / ENOENT / testSite 全链路。 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGlab } from '../../src/glab'
import { testSite } from '../../src/index'

describe.skipIf(process.platform === 'win32')('runGlab（真 spawn）', () => {
  let root: string
  let stub: string
  let repo: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-gitlab-int-'))
    stub = join(root, 'glab-stub')
    await writeFile(
      stub,
      [
        '#!/bin/sh',
        'echo "HOST=$GITLAB_HOST"',
        'echo "ARGS=$*"',
        'echo "PWD_DIR=$(pwd)"',
        'echo "ERRLINE" >&2',
      ].join('\n'),
    )
    await chmod(stub, 0o755)
    repo = join(root, 'repo')
    await rm(repo, { recursive: true, force: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(repo)
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const env = (host?: string): NodeJS.ProcessEnv => ({
    ...process.env,
    ...(host === undefined ? {} : { GITLAB_HOST: host }),
  })

  it('argv 直传、env 注入与 cwd 生效（不经 shell 解析）', async () => {
    const result = await runGlab({
      glabPath: stub,
      args: ['mr', 'list', '-R', 'group/repo'],
      cwd: repo,
      timeoutMs: 10_000,
      env: env('gitlab.yamu.com'),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('HOST=gitlab.yamu.com')
    expect(result.stdout).toContain('ARGS=mr list -R group/repo')
    // macOS 的 tmpdir 是符号链接（/var → /private/var）：pwd 输出物理路径，用 realpath 比对
    expect(result.stdout).toContain(`PWD_DIR=${realpathSync(repo)}`)
    expect(result.stderr).toContain('ERRLINE')
    expect(result.truncated).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it('退出码原样返回', async () => {
    const failing = join(root, 'glab-fail')
    await writeFile(failing, '#!/bin/sh\necho bad >&2\nexit 3\n')
    await chmod(failing, 0o755)
    const result = await runGlab({ glabPath: failing, args: [], timeoutMs: 10_000, env: env() })
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('bad')
  })

  it('超时终止进程并返回已捕获产物', async () => {
    const slow = join(root, 'glab-slow')
    await writeFile(slow, '#!/bin/sh\necho partial\nsleep 5\n')
    await chmod(slow, 0o755)
    const result = await runGlab({ glabPath: slow, args: [], timeoutMs: 400, env: env() })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.stdout).toContain('partial')
    expect(result.durationMs).toBeLessThan(3_000)
  })

  it('超长输出截断（头尾保留，总量有界）', async () => {
    const noisy = join(root, 'glab-noisy')
    await writeFile(noisy, '#!/bin/sh\nawk \'BEGIN{for(i=0;i<90000;i++) printf "x"}\'\n')
    await chmod(noisy, 0o755)
    const result = await runGlab({ glabPath: noisy, args: [], timeoutMs: 10_000, env: env() })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(16_000 * 2 + 8)
    expect(result.stdout.startsWith('x')).toBe(true)
    expect(result.stdout.endsWith('x')).toBe(true)
  })

  it('调用方取消：拒绝并携带 signal reason', async () => {
    const slow = join(root, 'glab-abort')
    await writeFile(slow, '#!/bin/sh\nsleep 5\n')
    await chmod(slow, 0o755)
    const controller = new AbortController()
    const pending = runGlab({ glabPath: slow, args: [], timeoutMs: 30_000, env: env() }, controller.signal)
    setTimeout(() => controller.abort(new Error('宿主取消')), 100)
    await expect(pending).rejects.toThrow('宿主取消')
  })

  it('二进制不存在：拒绝并带路径', async () => {
    await expect(
      runGlab({ glabPath: join(root, 'no-such-glab'), args: [], timeoutMs: 5_000, env: env() }),
    ).rejects.toThrow(/无法启动 glab/)
  })
})

describe.skipIf(process.platform === 'win32')('testSite（真 spawn 全链路）', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-gitlab-test-'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const script = async (name: string, body: string): Promise<string> => {
    const path = join(root, name)
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o755)
    return path
  }

  it('成功解析 username；--hostname 传给 glab', async () => {
    // stub 校验 argv 形态（api <user> --hostname <host>）后输出 user JSON
    const probe = join(root, 'probe-json')
    await writeFile(
      probe,
      '#!/bin/sh\n[ "$1" = api ] || exit 9\n[ "$3" = --hostname ] || exit 9\necho \'{"username":"stub"}\'\n',
    )
    await chmod(probe, 0o755)
    const result = await testSite(
      { glabStatus: () => ({ path: probe }) },
      { name: 'yamu', url: 'https://gitlab.yamu.com' },
      runGlab,
    )
    expect(result).toEqual({ ok: true, user: 'stub' })
  })

  it('非 0 退出码：ok=false 携带 stderr 原文', async () => {
    const glab = await script('probe-bad', 'echo "token 过期" >&2\nexit 1\n')
    const result = await testSite(
      { glabStatus: () => ({ path: glab }) },
      { name: 'yamu', url: 'https://gitlab.yamu.com' },
      runGlab,
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('token 过期')
  })

  it('stdout 非 JSON 也算认证通过（探测只回答认证通不通）', async () => {
    const glab = await script('probe-noisy', 'echo "登陆成功"\n')
    const result = await testSite(
      { glabStatus: () => ({ path: glab }) },
      { name: 'yamu', url: 'https://gitlab.yamu.com' },
      runGlab,
    )
    expect(result.ok).toBe(true)
    expect(result.user).toContain('已认证')
  })
})
