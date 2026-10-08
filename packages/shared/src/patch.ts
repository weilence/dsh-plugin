import { randomBytes } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Document, isCollection, isPair, isSeq, parseDocument } from 'yaml'

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

/** 扫描出的覆盖行（不带 insert、带 id）。 */
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

/** 解析 patch 文本；对齐官方 fail loud：空 / 仅注释 / 非序列 / 语法错误都抛，调用方转 HTTP 错误。 */
export function parsePatchDoc(text: string): Document {
  const document = parseDocument(text, PARSE_OPTIONS)
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('patch 文件必须是 YAML 顶层数组')
  return document as Document
}

/** 文件缺失时的新建基座；构造而非解析 '[]'，顶层不残留 flow 标记。 */
export function emptyPatchDoc(): Document {
  return new Document([])
}

/** 递归清除集合节点的 flow 标记——解析残留的内联风格（用户手写或旧版基座产物）不扩散到写盘形态。 */
function forceBlock(node: unknown): void {
  if (!isCollection(node)) return
  node.flow = false
  for (const item of node.items) {
    if (isPair(item)) {
      forceBlock(item.key)
      forceBlock(item.value)
    } else {
      forceBlock(item)
    }
  }
}

/** 序列化回文本：无数据落 `[]`，有数据一律 block 风格，结尾保证换行。 */
export function renderPatchDoc(document: Document): string {
  forceBlock(document.contents)
  const text = String(document)
  return text.endsWith('\n') ? text : `${text}\n`
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 扫描一个 patch 文档里的 insert 行与覆盖行（fold 序：后行整值覆盖前行）。
 *
 * insert 行无论声明的目标 group 是谁都计入（`patch.insert[*]`）；覆盖行
 * 只要有 id 就计入，是否命中目标行由调用方按 id 关联。
 */
export function scanPatchDoc(document: Document): { inserts: InsertRow[]; overrides: OverrideRow[] } {
  const inserts: InsertRow[] = []
  const overrides: OverrideRow[] = []
  const composed = document.toJS({ mapAsMap: false })
  const patches = Array.isArray(composed) ? (composed as unknown[]) : []
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
          disabled: typeof row.disabled === 'boolean' ? row.disabled : undefined,
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
      disabled: typeof patch.disabled === 'boolean' ? patch.disabled : undefined,
    })
  }
  return { inserts, overrides }
}
