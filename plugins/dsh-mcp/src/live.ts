import { Group, type Entry, type Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { MCP_PLUGIN_NAME } from './shared'

// FiberState 枚举的源序（cordis）：fiber.state 是数字，按序映射为名字。
const FIBER_STATES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const

export type FiberStatus = (typeof FIBER_STATES)[number]

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

function statusOf(fiber: Entry['fiber']): FiberStatus | 'absent' {
  if (fiber === undefined) return 'absent'
  return FIBER_STATES[fiber.state] ?? 'pending'
}

/** FAILED fiber 已结算：await() 立即重抛启动错误，取其消息做摘要。 */
async function errorOf(fiber: Entry['fiber'], status: FiberStatus | 'absent'): Promise<string | undefined> {
  if (fiber === undefined || status !== 'failed') return undefined
  try {
    await fiber.await()
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.length > 400 ? `${message.slice(0, 400)}…` : message
  }
}

function inSubtreeOf(entry: Entry): boolean {
  // bundle 声明的行由 cordis-plugin-group 的 Group 挂载（子树的直接属主），
  // 根树（profile / overlay 层）的属主不是 Group。
  return entry.parent instanceof Group
}

function toolPrefixOf(serverName: string): string {
  return `mcp__${serverName}__`
}

/**
 * 枚举当前 Loader 里所有 mcp-client 条目及其工具。loader / tools 不可用
 * （组合未提供）时返回空列表。
 */
export async function collectLiveMcp(
  loader: Loader | undefined,
  tools: ToolRuntime | undefined,
): Promise<LiveMcpRow[]> {
  if (loader === undefined) return []
  let toolNames: string[] = []
  if (tools !== undefined) {
    try {
      toolNames = tools.schemas().map((schema) => schema.name)
    } catch {
      toolNames = []
    }
  }
  const rows: LiveMcpRow[] = []
  for (const entry of loader.entries()) {
    const options = entry.options
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
