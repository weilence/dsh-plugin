// 落盘不经本模块（MCP 同步改为合并写远端 mcp.json；本模块只服务插件同步的层扫描）。
import {
  emptyPatchDoc,
  parsePatchDoc,
  scanPatchDoc,
  type Document,
  type InsertRow,
} from '@dsh-plugins/shared/patch'

export { emptyPatchDoc, parsePatchDoc }
export type { Document, InsertRow }

/** 扫描全部 insert 行（序号与文档条目对齐）。 */
export function scanInserts(document: Document): InsertRow[] {
  return scanPatchDoc(document).inserts
}
