// cordis.patch.yml 的注释保留编辑（insert 行 + 裸覆盖行，后行覆盖前行）；
// 全部编辑走 YAML Document API，手写注释与无关行原样保留。

import { randomBytes } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isMap, isSeq, parseDocument, type Document } from 'yaml'
import { MCP_PLUGIN_NAME } from './shared'

export type { Document }

/** 一条 insert 行在文件内的地址（顶层 patch 序号 × 行序号）。 */
export interface InsertAddress {
  patchIndex: number
  rowIndex: number
}

export interface InsertRow extends InsertAddress {
  id: string
  name: string
  config: unknown
  disabled: boolean | undefined
}

/** 扫描出的裸覆盖行（不带 insert、带 id）。 */
export interface OverrideRow {
  patchIndex: number
  id: string
  name: string | undefined
  config: unknown
  disabled: boolean | undefined
}

/** `!!js` 表达式在官方读取端被 resolve 成字符串；解析口径保持一致。 */
const PARSE_OPTIONS = {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
}

/** 解析 patch 文本；非序列或语法错误抛异常（调用方转 HTTP 错误）。 */
export function parsePatchDoc(text: string): Document {
  const document = parseDocument(text, PARSE_OPTIONS)
  const error = document.errors[0]
  if (error !== undefined) throw error
  // 仅注释 / 空文件解析为 null contents：视作空序列。
  if (document.contents === null) document.contents = document.createNode([]) as never
  if (!isSeq(document.contents)) throw new Error('patch 文件必须是 YAML 顶层数组')
  return document as Document
}

/** 空文档（文件缺失时的新建基座）。 */
export function emptyPatchDoc(): Document {
  return parsePatchDoc('[]\n')
}

/** 序列化回文本（保证结尾换行，diff 友好）。 */
export function renderPatchDoc(document: Document): string {
  const text = String(document)
  return text.endsWith('\n') ? text : `${text}\n`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 扫描一个 patch 文档里的 insert 行与裸覆盖行。
 *
 * insert 行无论声明的目标 group 是谁都计入（`patch.insert[*]`）；裸行
 * 只要有 id 就计入，是否命中 mcp 行由调用方按 id 关联。
 */
export function scanPatchDoc(document: Document): { inserts: InsertRow[]; overrides: OverrideRow[] } {
  const inserts: InsertRow[] = []
  const overrides: OverrideRow[] = []
  const patches = asRecordOrList(document.toJS({ mapAsMap: false }))
  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const patch = asRecord(patches[patchIndex])
    if (patch === undefined) continue
    const insert = patch.insert
    if (Array.isArray(insert)) {
      for (let rowIndex = 0; rowIndex < insert.length; rowIndex += 1) {
        const row = asRecord(insert[rowIndex])
        if (row === undefined) continue
        const id = row.id
        if (typeof id !== 'string' || id.length === 0) continue
        inserts.push({
          patchIndex,
          rowIndex,
          id,
          name: typeof row.name === 'string' ? row.name : '',
          config: row.config,
          disabled: booleanOrUndefined(row.disabled),
        })
      }
      continue
    }
    const id = patch.id
    if (typeof id !== 'string' || id.length === 0) continue
    overrides.push({
      patchIndex,
      id,
      name: typeof patch.name === 'string' ? patch.name : undefined,
      config: patch.config,
      disabled: booleanOrUndefined(patch.disabled),
    })
  }
  return { inserts, overrides }
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

/** 替换一条裸覆盖行的 config（编辑时让所有声明处与面板一致）。 */
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

/** 裸行键里属于条目本身的字段；只携带这些字段的覆盖行可整体移除。 */
const ENTRY_LEVEL_KEYS = new Set(['id', 'name', 'config', 'disabled', 'inject', 'group'])

/**
 * 移除所有整体针对某 id 的裸覆盖行。携带条目级以外键（如顶层 group
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
 * 一条不带 insert、id 匹配（且 name 缺席或与插件名一致）的裸行，改其
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

/** 原子写文本：同目录临时文件 + rename（对齐官方 writeFileAtomic 的落盘形态）。 */
export async function writeTextAtomic(filename: string, text: string): Promise<void> {
  const temporary = join(
    dirname(filename),
    `.${basename(filename)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  )
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, filename)
}
