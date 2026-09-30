import { isMap, isSeq } from 'yaml'
import { MCP_PLUGIN_NAME } from './shared'
// 通用 patch 文档原语（解析 / 渲染 / 原子落盘 / 行扫描）已抽至共享包，
// 本模块只保留 MCP 特有的编辑操作。
import type { Document, InsertAddress } from '@dsh-plugins/shared/patch'

export type { Document, InsertAddress, InsertRow, OverrideRow } from '@dsh-plugins/shared/patch'
export {
  emptyPatchDoc,
  parsePatchDoc,
  renderPatchDoc,
  scanPatchDoc,
  writeTextAtomic,
} from '@dsh-plugins/shared/patch'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asRecordOrList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 在文档末尾追加一条 mcp-client insert 行。 */
export function appendMcpInsert(document: Document, row: { id: string; config: object }): void {
  document.add({
    insert: [{ id: row.id, name: MCP_PLUGIN_NAME, config: document.createNode(row.config) }],
  })
}

/** 替换一条 insert 行的 config（整体替换，与组合语义一致）。 */
export function setInsertConfig(document: Document, address: InsertAddress, config: object): void {
  document.setIn([address.patchIndex, 'insert', address.rowIndex, 'config'], document.createNode(config))
}

/** 替换一条覆盖行的 config（编辑时让所有声明处与面板一致）。 */
export function setOverrideConfig(document: Document, patchIndex: number, config: object): void {
  document.setIn([patchIndex, 'config'], document.createNode(config))
}

/** 删除一条 insert 行；宿主 patch 项只剩空 insert 时连同该项一起移除。 */
export function removeInsertRow(document: Document, address: InsertAddress): void {
  const items = (document.contents as { items: unknown[] }).items
  const patch = items[address.patchIndex]
  if (!isMap(patch)) return
  const insert = patch.get('insert')
  if (!isSeq(insert)) return
  insert.items.splice(address.rowIndex, 1)
  if (insert.items.length === 0 && patch.items.every((pair) => pair.key?.toString() === 'insert')) {
    items.splice(address.patchIndex, 1)
  }
}

/** 覆盖行键里属于条目本身的字段；只携带这些字段的覆盖行可整体移除。 */
const ENTRY_LEVEL_KEYS = new Set(['id', 'name', 'config', 'disabled', 'inject', 'group'])

/**
 * 移除所有整体针对某 id 的覆盖行。携带条目级以外键（如顶层 group
 * 结构键）的行保留，避免破坏用户手写的其他结构。
 */
export function removeOverridesOf(document: Document, id: string): void {
  const items = (document.contents as { items: unknown[] }).items
  const patches = asRecordOrList(document.toJS({ mapAsMap: false }))
  for (let patchIndex = items.length - 1; patchIndex >= 0; patchIndex -= 1) {
    const item = items[patchIndex]
    if (!isMap(item) || item.has('insert')) continue
    if (asRecord(patches[patchIndex])?.id !== id) continue
    const foreign = item.items.some((pair) => !ENTRY_LEVEL_KEYS.has(pair.key?.toString() ?? ''))
    if (foreign) continue
    items.splice(patchIndex, 1)
  }
}

/**
 * 停用 / 启用一个 id：镜像官方 writePluginEnabled 的落盘形态——找到最后
 * 一条不带 insert、id 匹配（且 name 缺失或与插件名一致）的覆盖行，改其
 * disabled；没有则追加 `{ id, disabled }`。返回文档是否变化。
 */
export function setEnabledInDoc(document: Document, id: string, enabled: boolean): boolean {
  const patches = asRecordOrList(document.toJS({ mapAsMap: false }))
  let targetIndex = -1
  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const patch = asRecord(patches[patchIndex])
    if (patch === undefined || patch.insert !== undefined) continue
    if (patch.id !== id) continue
    if (patch.name !== undefined && patch.name !== MCP_PLUGIN_NAME) continue
    targetIndex = patchIndex
  }
  if (targetIndex >= 0) {
    if (asRecord(patches[targetIndex])?.disabled === !enabled) return false
    document.setIn([targetIndex, 'disabled'], !enabled)
    return true
  }
  document.add({ id, disabled: !enabled })
  return true
}
