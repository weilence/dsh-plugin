import { MCP_PLUGIN_NAME } from './shared'

// FiberState 枚举的源序（cordis）：fiber.state 是数字，按序映射为名字。
const FIBER_STATES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const

export type FiberStatus = (typeof FIBER_STATES)[number]

// 官方类型未入本仓库 catalog：全部经结构化最小接口防御式读取，偏差时降级。
interface FiberLike {
  state: number
  await(): Promise<unknown>
}

interface EntryLike {
  options?: { id?: unknown; name?: unknown; config?: unknown }
  disabled?: boolean
  fiber?: FiberLike
  parent?: unknown
}

interface GroupLike {
  subtree?: unknown
  parent?: unknown
}

interface LoaderLike {
  entries(): IterableIterator<EntryLike>
}

interface ToolsLike {
  schemas(): { name: unknown }[]
}

/** 一条 mcp-client 实例的运行态快照。 */
export interface LiveMcpRow {
  /** 树内 patch id（bundle 子树里是子树局部 id）。 */
  patchId: string
  serverName: string | undefined
  /** 条目声明的原始配置（只读行的面板展示用）。 */
  config: Record<string, unknown>
  disabled: boolean
  status: FiberStatus | 'absent'
  error: string | undefined
  tools: string[]
  /** 条目挂在 include 子树里（bundle 声明）而非根树（profile/overlay 层）。 */
  inSubtree: boolean
}

function statusOf(fiber: FiberLike | undefined): FiberStatus | 'absent' {
  if (fiber === undefined) return 'absent'
  return FIBER_STATES[fiber.state] ?? 'pending'
}

/** FAILED fiber 已结算：await() 立即重抛启动错误，取其消息做摘要。 */
async function errorOf(
  fiber: FiberLike | undefined,
  status: FiberStatus | 'absent',
): Promise<string | undefined> {
  if (fiber === undefined || status !== 'failed') return undefined
  try {
    await fiber.await()
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.length > 400 ? `${message.slice(0, 400)}…` : message
  }
}

function inSubtreeOf(entry: EntryLike): boolean {
  let group = entry.parent as GroupLike | undefined
  while (group !== undefined && group !== null) {
    if (group.subtree !== undefined) return true
    group = group.parent as GroupLike | undefined
  }
  return false
}

function toolPrefixOf(serverName: string): string {
  return `mcp__${serverName}__`
}

/**
 * 枚举当前 Loader 里所有 mcp-client 条目及其工具。loader / tools 缺席
 * （组合未提供）时返回空列表。
 */
export async function collectLiveMcp(
  loader: LoaderLike | undefined,
  tools: ToolsLike | undefined,
): Promise<LiveMcpRow[]> {
  if (loader === undefined) return []
  let toolNames: string[] = []
  if (tools !== undefined) {
    try {
      toolNames = tools.schemas().flatMap((schema) => (typeof schema.name === 'string' ? [schema.name] : []))
    } catch {
      toolNames = []
    }
  }
  const rows: LiveMcpRow[] = []
  for (const entry of loader.entries()) {
    const options = entry.options ?? {}
    if (options.name !== MCP_PLUGIN_NAME) continue
    if (typeof options.id !== 'string' || options.id.length === 0) continue
    const config = (
      typeof options.config === 'object' && options.config !== null ? options.config : {}
    ) as Record<string, unknown>
    const serverName = typeof config.serverName === 'string' ? config.serverName : undefined
    const fiber = entry.fiber
    const status = statusOf(fiber)
    const toolsForServer =
      serverName === undefined ? [] : toolNames.filter((name) => name.startsWith(toolPrefixOf(serverName)))
    rows.push({
      patchId: options.id,
      serverName,
      config,
      disabled: entry.disabled === true,
      status,
      error: await errorOf(fiber, status),
      tools: toolsForServer,
      inSubtree: inSubtreeOf(entry),
    })
  }
  return rows
}
