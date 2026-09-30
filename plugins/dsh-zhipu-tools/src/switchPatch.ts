import { isMap } from 'yaml'
import type { Document } from '@dsh-plugins/shared/patch'
import { scanPatchDoc } from '@dsh-plugins/shared/patch'
import { OFFICIAL_PROVIDER, ZHIPU_PROVIDER } from './shared'

/** 官方 web 行的条目 id 与插件名（name 同时是覆盖守卫）。 */
export const WEB_ROW_ID = 'web'
export const WEB_PLUGIN_NAME = '@deepseek-ai/dsh-web'

/** 行注释里的托管标记：managed = 本插件新建（关闭时整行删除）。 */
const MANAGED_MARKER = 'dsh-zhipu-tools managed'
/** 行注释里的原值标记：previous: <provider|none>（关闭时恢复）。 */
const PREVIOUS_RE = /dsh-zhipu-tools previous: ([A-Za-z0-9_.-]+)/

/** 一条 web 覆盖行在文件内的地址与内容。 */
export interface WebRow {
  patchIndex: number
  name: string | undefined
  config: Record<string, unknown> | undefined
  disabled: boolean | undefined
  /** 行节点的 commentBefore 原文（标记识别用）。 */
  comment: string | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 扫描一个 patch 文档里指向官方 web 行的覆盖行（id 匹配且 name 缺失或
 * 一致——name 不一致的行宿主会跳过，不参与 fold，也不该被本开关修改）。
 * 返回保持文件顺序（后行覆盖前行）。
 */
export function scanWebRows(document: Document): WebRow[] {
  const items = (document.contents as unknown as { items: unknown[] }).items
  return scanPatchDoc(document)
    .overrides.filter(
      (row) => row.id === WEB_ROW_ID && (row.name === undefined || row.name === WEB_PLUGIN_NAME),
    )
    .map((row) => {
      const node = items[row.patchIndex] as { commentBefore?: string | null } | undefined
      return {
        patchIndex: row.patchIndex,
        name: row.name,
        config: asRecord(row.config),
        disabled: row.disabled,
        comment: node?.commentBefore ?? undefined,
      }
    })
}

/** 覆盖行键里属于条目本身的字段；携带其他键的行不整行删除。 */
const ENTRY_LEVEL_KEYS = new Set([
  'id',
  'name',
  'config',
  'disabled',
  'inject',
  'intercept',
  'isolate',
  'group',
])

function rowNodeAt(document: Document, patchIndex: number): { commentBefore?: string | null } | undefined {
  const items = (document.contents as unknown as { items: unknown[] }).items
  return items[patchIndex] as { commentBefore?: string | null } | undefined
}

/** 替换行注释：保留用户注释行，仅维护本插件的一行标记。 */
function setMarkerLine(document: Document, patchIndex: number, line: string | null): void {
  const node = rowNodeAt(document, patchIndex)
  if (node === undefined) return
  const lines = (node.commentBefore ?? '')
    .split('\n')
    .filter((text) => text.trim().length > 0 && !text.includes('dsh-zhipu-tools'))
  const next = line === null ? lines : [...lines, line]
  node.commentBefore = next.length > 0 ? next.join('\n') : null
}

/**
 * 就地启用：把生效行的 searchProvider 精确改为智谱（只动这一个键，行内
 * 其他 config 键与注释原样保留），并在行注释记录原值供关闭恢复。
 * 返回是否发生变更：已是智谱的行不重写标记——手写智谱行保持无标记
 * （关闭语义 = 回官方），带标记的智谱行保持原标记（关闭恢复原值）。
 */
export function enableInRow(document: Document, row: WebRow): boolean {
  const previous = row.config?.searchProvider
  if (previous === ZHIPU_PROVIDER) return false
  if (row.config === undefined) {
    document.setIn([row.patchIndex, 'config'], { searchProvider: ZHIPU_PROVIDER })
  } else {
    document.setIn([row.patchIndex, 'config', 'searchProvider'], ZHIPU_PROVIDER)
  }
  const previousText = typeof previous === 'string' && previous.length > 0 ? previous : 'none'
  setMarkerLine(document, row.patchIndex, `# dsh-zhipu-tools previous: ${previousText}`)
  return true
}

/**
 * 在文档末尾追加本插件托管的 web 覆盖行（两层都没有 web 行时使用）。
 * config 以当前生效配置为底整体替换——漏掉 fetchProvider 会把官方抓取打掉。
 */
export function appendManagedRow(document: Document, config: Record<string, unknown>): void {
  const node = document.createNode({
    id: WEB_ROW_ID,
    name: WEB_PLUGIN_NAME,
    config,
  })
  node.commentBefore = `# ${MANAGED_MARKER}（关闭时删除本行，回落更低层的当前值）`
  document.add(node)
}

/**
 * 就地关闭。返回是否发生变更。
 * - 本插件新建的行（managed 标记）：整行删除；行携带条目级以外的键时保守
 *   降级为改回官方默认，不删行。
 * - 本插件改过的行（previous 标记）：恢复原值（none = 删除该键）。
 * - 用户手写的智谱行（无标记）：searchProvider 改回官方默认——「关闭」的
 *   语义即回到官方；面板在操作前已提示会写入该值。
 * - 当前值不是智谱：不动。
 */
export function disableInRow(document: Document, row: WebRow): boolean {
  if (row.config?.searchProvider !== ZHIPU_PROVIDER) return false
  const comment = row.comment ?? ''
  if (comment.includes(MANAGED_MARKER)) {
    const node = rowNodeAt(document, row.patchIndex)
    const foreign =
      isMap(node) &&
      (node as unknown as { items: { key?: { toString(): string } }[] }).items.some(
        (pair) => !ENTRY_LEVEL_KEYS.has(pair.key?.toString() ?? ''),
      )
    if (!foreign) {
      const items = (document.contents as unknown as { items: unknown[] }).items
      items.splice(row.patchIndex, 1)
      return true
    }
  }
  const match = PREVIOUS_RE.exec(comment)
  if (match !== null) {
    if (match[1] === 'none') document.deleteIn([row.patchIndex, 'config', 'searchProvider'])
    else document.setIn([row.patchIndex, 'config', 'searchProvider'], match[1])
  } else {
    document.setIn([row.patchIndex, 'config', 'searchProvider'], OFFICIAL_PROVIDER)
  }
  setMarkerLine(document, row.patchIndex, null)
  return true
}
