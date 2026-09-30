import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { killOrphanForward } from './ssh'

/** 本地转发进程的租约记录。宿主重启会清空内存运行态，但 spawn 出的 ssh 子进程
 *  不随父进程退出而亡（SIGKILL / 崩溃不走 dispose 兜底）——租约落盘让引擎下次
 *  load 时能认领并清掉遗留进程，「宿主重启即回到 idle」才名副其实（idle 且无
 *  幽灵隧道）。短命记录：读不到 / 损坏一律从空开始，不参与任何连接判定。 */
export interface ForwardLease {
  pid: number
  localPort: number
  remotePort: number
  at: string
}

export type ForwardLeases = Record<string, ForwardLease>

/** 清扫单个遗留的结果：killed / dead 都清租约（dead 含 pid 已被无关进程复用——
 *  只清记录不动进程）；unverified（核验工具缺失）保留待下次再试。 */
export type SweepOutcome = 'killed' | 'dead' | 'unverified'

function leaseFile(homeDir: string): string {
  return join(homeDir, 'dsh-remote', 'forwards.json')
}

export class ForwardRegistry {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly homeDir: string,
    private readonly killOrphan: (
      pid: number,
      localPort: number,
    ) => Promise<SweepOutcome> = killOrphanForward,
  ) {}

  /** 引擎 load 时清扫上个宿主生命周期遗留的转发。 */
  sweep(): Promise<void> {
    return this.enqueue(async () => {
      const leases = await this.read()
      for (const [id, lease] of Object.entries(leases)) {
        if ((await this.killOrphan(lease.pid, lease.localPort)) !== 'unverified') delete leases[id]
      }
      await this.write(leases)
    })
  }

  record(id: string, lease: ForwardLease): Promise<void> {
    return this.enqueue(async () => {
      const leases = await this.read()
      leases[id] = lease
      await this.write(leases)
    })
  }

  clear(id: string): Promise<void> {
    return this.enqueue(async () => {
      const leases = await this.read()
      if (id in leases) {
        delete leases[id]
        await this.write(leases)
      }
    })
  }

  clearAll(): Promise<void> {
    return this.enqueue(() => this.write({}))
  }

  /** 串行化读改写：转发死亡清理（异步事件）与连接落盘并发时避免覆盖丢记录。 */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.tail.then(operation, operation)
    this.tail = next
    return next
  }

  private async read(): Promise<ForwardLeases> {
    let text: string
    try {
      text = await readFile(leaseFile(this.homeDir), 'utf8')
    } catch {
      return {}
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {}
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const leases: ForwardLeases = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const { pid, localPort, remotePort, at } = value as Record<string, unknown>
      if (
        typeof pid === 'number' &&
        Number.isInteger(pid) &&
        pid > 0 &&
        typeof localPort === 'number' &&
        typeof remotePort === 'number' &&
        typeof at === 'string'
      ) {
        leases[id] = { pid, localPort, remotePort, at }
      }
    }
    return leases
  }

  private async write(leases: ForwardLeases): Promise<void> {
    await mkdir(join(this.homeDir, 'dsh-remote'), { recursive: true })
    await writeFile(leaseFile(this.homeDir), `${JSON.stringify(leases, null, 2)}\n`, 'utf8')
  }
}
