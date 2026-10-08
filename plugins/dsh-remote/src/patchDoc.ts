// 落盘不经本模块（cat→改→cat 在 ssh 通道内原子完成），只做文本 ↔ Document 的内存编辑。
import { isMap, isSeq, type Document } from 'yaml'
import {
  emptyPatchDoc,
  parsePatchDoc,
  renderPatchDoc,
  scanPatchDoc,
  type InsertRow,
} from '@dsh-plugins/shared/patch'

export { emptyPatchDoc, parsePatchDoc, renderPatchDoc }
export type { Document, InsertRow }

/** 扫描全部 insert 行（序号与文档条目对齐）。 */
export function scanInserts(document: Document): InsertRow[] {
  return scanPatchDoc(document).inserts
}

/**
 * 按 id 整块替换或新增一条 insert 行：同 id 且同插件名的行替换 config 与
 * disabled（与组合语义一致，不深合并）；否则在文档末尾追加规范形态。同 id
 * 但插件名不同的行不动——那是别的插件拥有的行。
 */
export function upsertInsertRow(
  document: Document,
  row: { id: string; name: string; config: Record<string, unknown>; disabled?: boolean },
): void {
  const existing = scanInserts(document).find(
    (candidate) => candidate.id === row.id && candidate.name === row.name,
  )
  if (existing !== undefined) {
    document.setIn(
      [existing.patchIndex, 'insert', existing.rowIndex, 'config'],
      document.createNode(row.config),
    )
    if (row.disabled !== undefined) {
      document.setIn([existing.patchIndex, 'insert', existing.rowIndex, 'disabled'], row.disabled)
    }
    return
  }
  const entry: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    config: document.createNode(row.config),
  }
  if (row.disabled !== undefined) entry.disabled = row.disabled
  document.add({ insert: [entry] })
}

/**
 * 移除所有 id 命中集合的 insert 行（宿主 patch 项只剩空 insert 时连同
 * 该项一起移除）。返回移除的行数。按地址倒序删除，索引不漂移。
 */
export function removeInsertRows(document: Document, ids: ReadonlySet<string>): number {
  const targets = scanInserts(document)
    .filter((row) => ids.has(row.id))
    .sort((left, right) => right.patchIndex - left.patchIndex || right.rowIndex - left.rowIndex)
  let removed = 0
  for (const target of targets) {
    const items = (document.contents as { items: unknown[] }).items
    const patch = items[target.patchIndex]
    if (!isMap(patch)) continue
    const insert = patch.get('insert')
    if (!isSeq(insert)) continue
    insert.items.splice(target.rowIndex, 1)
    if (insert.items.length === 0 && patch.items.every((pair) => pair.key?.toString() === 'insert')) {
      items.splice(target.patchIndex, 1)
    }
    removed += 1
  }
  return removed
}
