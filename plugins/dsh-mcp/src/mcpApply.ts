import { deepEqual } from '@deepseek-ai/cosmokit'
import { errMsg } from '@dsh-plugins/shared'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { ENTRY_PREFIX, MCP_PLUGIN_NAME, entryIdOf, type McpScope } from './shared'

/**
 * 文件期望集 ↔ Loader 运行实例的对齐：本插件把两份 .mcp.json 的有效条目
 * 动态挂载成 mcp-client 行（Loader 根树是内存态，write() 为 no-op，不会
 * 写回任何配置文件）。diff 只认自己的 `mcpx-` id 前缀，patch 文件与其他
 * 插件挂的 mcp-client 行一律不碰。
 */

/** 一个期望挂载的条目：来自文件里的合法条目（无效与被遮蔽的不会进来）。 */
export interface DesiredEntry {
  scope: McpScope
  name: string
  config: Record<string, unknown>
  disabled: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 当前挂载的、属于本插件的条目（id → 生效配置与停用态）。 */
export function mountedEntries(
  loader: Loader | undefined,
): Map<string, { config: Record<string, unknown>; disabled: boolean }> {
  const result = new Map<string, { config: Record<string, unknown>; disabled: boolean }>()
  if (loader === undefined) return result
  for (const entry of loader.entries()) {
    const options = entry.options
    if (options.name !== MCP_PLUGIN_NAME) continue
    if (typeof options.id !== 'string' || !options.id.startsWith(ENTRY_PREFIX)) continue
    result.set(options.id, { config: asRecord(options.config), disabled: entry.disabled === true })
  }
  return result
}

/** 对齐期望集：create / update / remove 全部走 Loader 运行时 API。非致命
 *  失败收进返回的告警（面板展示），不中断其余条目的同步。 */
export async function syncEntries(loader: Loader | undefined, desired: DesiredEntry[]): Promise<string[]> {
  const warnings: string[] = []
  if (loader === undefined) {
    if (desired.length > 0) warnings.push('loader 服务不可用，无法动态挂载 MCP 服务器（重启宿主或检查组合）')
    return warnings
  }
  const mounted = mountedEntries(loader)
  const desiredIds = new Set<string>()
  for (const item of desired) {
    const id = entryIdOf(item.scope, item.name)
    desiredIds.add(id)
    const current = mounted.get(id)
    if (
      current !== undefined &&
      deepEqual(current.config, item.config) &&
      current.disabled === item.disabled
    ) {
      continue
    }
    try {
      if (current === undefined) {
        // id 被非本插件的行占用时拒绝创建：不劫持别人的行，只告警。
        const existing = loader.store[id]
        if (existing !== undefined && existing.options.name !== MCP_PLUGIN_NAME) {
          warnings.push(`行 id「${id}」已被 ${String(existing.options.name)} 占用，跳过挂载「${item.name}」`)
          continue
        }
        // create 的参数类型按「无 id」声明（缺省随机生成），运行时 ensureId
        // 对显式给出的 id 原样保留——diff 依赖稳定 id，所以带 id 传入。
        const options = { name: MCP_PLUGIN_NAME, id, config: { ...item.config }, disabled: item.disabled }
        await loader.create(options as Parameters<Loader['create']>[0])
      } else {
        await loader.update(id, { config: { ...item.config }, disabled: item.disabled })
      }
    } catch (error) {
      warnings.push(`挂载「${item.name}」失败：${errMsg(error)}`)
    }
  }
  for (const id of mounted.keys()) {
    if (desiredIds.has(id)) continue
    try {
      loader.remove(id)
    } catch (error) {
      warnings.push(`卸载条目「${id}」失败：${errMsg(error)}`)
    }
  }
  return warnings
}

/** 卸载本插件名下的全部条目（插件自身 dispose 时调用）。 */
export function removeAllEntries(loader: Loader | undefined): void {
  if (loader === undefined) return
  for (const id of mountedEntries(loader).keys()) {
    try {
      loader.remove(id)
    } catch {
      // 树正在整体拆除时条目可能已不在：卸载清理尽力即可。
    }
  }
}
