/** 转发租约：读写往返 / 损坏回空 / sweep 三态（killed·dead 清租约、unverified 保留）；
 *  killOrphanForward 用假 ssh 可执行文件真跑子进程核验（本插件形态杀、端口不符与
 *  无关进程不误杀）。 */

import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ForwardRegistry, type ForwardLease } from '../src/forwards'
import { killOrphanForward } from '../src/ssh'

const NOW = '2027-01-01T00:00:00.000Z'

function lease(pid: number): ForwardLease {
  return { pid, localPort: 19999, remotePort: 4321, at: NOW }
}

describe('ForwardRegistry', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-remote-forwards-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const file = () => join(home, 'dsh-remote', 'forwards.json')

  it('record 落盘可读回；clear 移除该条；损坏文件回空重记', async () => {
    const registry = new ForwardRegistry(home, async () => 'killed')
    await registry.record('dev-box', lease(11))
    await registry.record('other', lease(22))
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      'dev-box': lease(11),
      other: lease(22),
    })
    await registry.clear('dev-box')
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ other: lease(22) })

    await writeFile(file(), '{broken', 'utf8')
    await registry.record('third', lease(33))
    // 损坏即弃：从空开始，只剩新写入的条目
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ third: lease(33) })
  })

  it('sweep：killed 与 dead 清租约，unverified 保留待下次；clearAll 清全部', async () => {
    const outcomes: ('killed' | 'dead' | 'unverified')[] = ['killed', 'unverified', 'dead']
    const seen: number[] = []
    const registry = new ForwardRegistry(home, async (pid) => {
      seen.push(pid)
      return outcomes.shift() ?? 'killed'
    })
    await registry.record('a', lease(1))
    await registry.record('b', lease(2))
    await registry.record('c', lease(3))
    await registry.sweep()
    expect(seen).toEqual([1, 2, 3])
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ b: lease(2) })

    // unverified 条目下次清扫恢复 killed 后一并清掉
    await registry.sweep()
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({})

    await registry.record('d', lease(4))
    await registry.clearAll()
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({})
  })
})

describe('killOrphanForward', () => {
  // ps 核验与 shell 可执行文件都不可用 / 无意义于 Windows，仅 unix 真跑子进程
  const unixOnly = process.platform === 'win32' ? it.skip : it
  let dir: string
  let children: ChildProcess[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-orphan-'))
    children = []
  })

  afterEach(async () => {
    for (const child of children) child.kill()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  /** 命令行形态与本插件转发一致的假 ssh（exec sleep 使 pid 不变）。 */
  async function spawnFakeForward(localPort: number): Promise<ChildProcess> {
    const fakeSsh = join(dir, 'ssh')
    await writeFile(fakeSsh, '#!/bin/sh\nexec sleep 300\n', 'utf8')
    await chmod(fakeSsh, 0o755)
    const child = spawn(fakeSsh, [
      '-o',
      'BatchMode=yes',
      '-N',
      '-L',
      `127.0.0.1:${localPort}:127.0.0.1:4321`,
      'dev-box',
    ])
    children.push(child)
    await new Promise<void>((resolve) => child.once('spawn', resolve))
    if (child.pid === undefined) throw new Error('测试子进程未启动')
    return child
  }

  unixOnly('本插件形态的转发进程 → killed 且进程退出', async () => {
    const child = await spawnFakeForward(19999)
    const exited = new Promise<void>((resolve) => child.once('exit', resolve))
    expect(await killOrphanForward(child.pid!, 19999)).toBe('killed')
    await exited
  })

  unixOnly('端口不符 / 无关进程 → 只清租约不杀（防 pid 复用误杀）', async () => {
    const forward = await spawnFakeForward(19999)
    const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'])
    children.push(unrelated)
    await new Promise<void>((resolve) => unrelated.once('spawn', resolve))
    if (unrelated.pid === undefined) throw new Error('测试子进程未启动')
    expect(await killOrphanForward(forward.pid!, 19998)).toBe('dead')
    expect(await killOrphanForward(unrelated.pid, 19999)).toBe('dead')
    expect(forward.exitCode).toBeNull()
    expect(unrelated.exitCode).toBeNull()
  })

  it('pid 非法 → dead（不触核验工具）', async () => {
    expect(await killOrphanForward(-1, 19999)).toBe('dead')
    expect(await killOrphanForward(Number.NaN, 19999)).toBe('dead')
  })
})
