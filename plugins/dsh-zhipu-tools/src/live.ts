import { Group, type Entry, type Loader } from '@deepseek-ai/cordis-plugin-loader'
import { WEB_ROW_ID } from './switchPatch'

/** 生效配置里 web 行的来源层。 */
export type WebOrigin = 'bundle' | 'file' | 'cli' | 'missing'

/** 运行时 web 行的内省快照。 */
export interface LiveWebEntry {
  disabled: boolean
  /** 条目声明的配置（组合折叠后的最终值，即实际生效配置）。 */
  config: Record<string, unknown>
  origin: WebOrigin
}

/**
 * 进程参数里是否带 `--patch`。宿主把所有层（bundle patch、用户层、CLI
 * `--patch`）统一摊平进同一个根 include 树（app-boot 单一 bootstrap
 * include），树形结构区分不出 CLI 来源——只能以参数实际在场为准。
 */
export function hasCliPatchArg(argv: readonly string[] = process.argv): boolean {
  return argv.some((arg) => arg === '--patch' || arg.startsWith('--patch='))
}

/** 内省结果：loader 不可用（降级）与「组合里没有 web 行」是两种不同状态。 */
export type LiveWebLookup = { introspectable: false } | { introspectable: true; entry: LiveWebEntry }

/**
 * 从 Loader 内省 id 为 web 的组合条目并判定来源层：
 * - file：两层用户文件存在同 id 行——就地修改它必然影响生效值；
 * - bundle：条目在 include 子树，或宿主摊平挂载且无 CLI 覆盖——用户
 *   home 层排在 bundle 之后，写入即可覆盖；
 * - cli：摊平挂载 + 两层文件无行 + 进程带 `--patch`——文件改不动它；
 * - missing：组合里没有 web 行。
 */
export function lookupLiveWeb(
  loader: Loader | undefined,
  fileHasWebRow: boolean,
  cliPatch = hasCliPatchArg(),
): LiveWebLookup {
  if (loader === undefined) return { introspectable: false }
  try {
    for (const entry of loader.entries()) {
      const options = entry.options
      if (options.id !== WEB_ROW_ID) continue
      const inSubtree = inSubtreeOf(entry)
      return {
        introspectable: true,
        entry: {
          disabled: entry.disabled === true,
          config: asRecord(options.config) ?? {},
          origin: inSubtree || !cliPatch ? 'bundle' : fileHasWebRow ? 'file' : 'cli',
        },
      }
    }
  } catch {
    // 内省异常与不可用同等对待：调用方按降级路径展示。
  }
  return { introspectable: true, entry: { disabled: false, config: {}, origin: 'missing' } }
}

/** 生效配置里的 searchProvider 字符串值（缺省 = null，即自动选择模式）。 */
export function providerOf(entry: LiveWebEntry): string | null {
  if (entry.disabled) return null
  const provider = entry.config.searchProvider
  return typeof provider === 'string' && provider.length > 0 ? provider : null
}

function inSubtreeOf(entry: Entry): boolean {
  // bundle 声明的行由 cordis-plugin-group 的 Group 挂载（子树的直接属主），
  // 根树（profile / overlay 层）的属主不是 Group。
  return entry.parent instanceof Group
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
