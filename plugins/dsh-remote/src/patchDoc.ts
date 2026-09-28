/**
 * cordis.patch.yml 的注释保留合并（host 专用）：dsh-remote 只做「按行 id
 * 整块替换 / 新增 / 移除插件拥有的行」，编辑面比 dsh-mcp 的 patchFile 小，
 * 但往返性质相同——解析容忍 `!!js` 自定义标签、写侧走 Document API、
 * 无关行与手写注释原样保留。
 *
 * 远端往返的落盘不经本模块（cat→改→cat 在 ssh 通道内原子完成），这里
 * 只负责文本 ↔ Document 的内存编辑。
 */

import { isMap, isSeq, parseDocument, type Document } from 'yaml'

export type { Document }

/** `!!js` 表达式在官方读取端被 resolve 成字符串；解析口径保持一致。 */
const PARSE_OPTIONS = {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
}

/** 解析 patch 文本；语法错误抛异常（调用方转操作错误）。 */
export function parsePatchDoc(text: string): Document {
  const document = parseDocument(text, PARSE_OPTIONS)
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (document.contents === null) document.contents = document.createNode([]) as never
  if (!isSeq(document.contents)) throw new Error('patch 文件必须是 YAML 顶层数组')
  return document as Document
}

/** 空文档（远端文件缺失时的合并基座）。 */
export function emptyPatchDoc(): Document {
  return parsePatchDoc('[]\n')
}

/** 序列化回文本（保证结尾换行）。 */
export function renderPatchDoc(document: Document): string {
  const text = String(document)
  return text.endsWith('\n') ? text : `${text}\n`
}

/** 扫描出的一条 insert 行。 */
export interface PatchInsert {
  id: string
  name: string
  config: unknown
  disabled: boolean | undefined
  patchIndex: number
  rowIndex: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 扫描全部 insert 行（读侧走 toJS 纯结构，序号与文档条目对齐）。 */
export function scanInserts(document: Document): PatchInsert[] {
  const composed = document.toJS({ mapAsMap: false })
  const patches = Array.isArray(composed) ? (composed as unknown[]) : []
  const inserts: PatchInsert[] = []
  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const patch = asRecord(patches[patchIndex])
    if (patch === undefined || !Array.isArray(patch.insert)) continue
    for (let rowIndex = 0; rowIndex < patch.insert.length; rowIndex += 1) {
      const row = asRecord(patch.insert[rowIndex])
      if (row === undefined) continue
      const id = row.id
      if (typeof id !== 'string' || id.length === 0) continue
      inserts.push({
        id,
        name: typeof row.name === 'string' ? row.name : '',
        config: row.config,
        disabled: typeof row.disabled === 'boolean' ? row.disabled : undefined,
        patchIndex,
        rowIndex,
      })
    }
  }
  return inserts
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
    .sort((left, right) => left.patchIndex - right.patchIndex || left.rowIndex - right.rowIndex)
    .reverse()
  for (const target of targets) removeInsertRowAt(document, target)
  return targets.length
}

function removeInsertRowAt(document: Document, address: { patchIndex: number; rowIndex: number }): void {
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
