/**
 * 一键写入内置 Web 搜索配置的 patch 行级 upsert：把 `web-deepseek-api`
 * （apiKeyEnv 指向智谱凭据 + baseURL 指向本地端点）与 `web`（启用新版
 * Search / Fetch provider）两行并入用户 profile patch。输入输出都是文件
 * 全文：parse → 节点级定位 → render，保留用户注释、无关行与既有行的
 * 未知配置键。`web-deepseek-api` 不再有自己的访问令牌——web_search 直接
 * 复用智谱凭据，端点验收同一把 Key（见 endpoint.ts）。
 */
import { isMap, isSeq, type Document } from 'yaml'
import { emptyPatchDoc, parsePatchDoc, renderPatchDoc, scanPatchDoc } from '@dsh-plugins/shared/patch'
import { KEY_REFS } from './shared'

/** 一条目标行的静态描述：id 定位既有行，name 供新建，config 为本插件负责的键值。 */
interface RowSpec {
  id: string
  name: string
  config: Record<string, string>
}

/** web_search / web_fetch 的密钥引用与端点地址行。 */
function webDeepseekApiRow(baseURL: string): RowSpec {
  return {
    id: 'web-deepseek-api',
    name: '@deepseek-ai/dsh-web-deepseek-api',
    config: { apiKeyEnv: KEY_REFS[0], baseURL },
  }
}

/** 启用新版 Web Search / Fetch API 的 provider 选择行。 */
function webRow(): RowSpec {
  return {
    id: 'web',
    name: '@deepseek-ai/dsh-web',
    config: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
  }
}

/**
 * 把两行配置 upsert 进 patch 文本，返回新文本。按 id 取 fold 序中最后一条
 * override 行就地合并；行缺失则文末追加。`web-deepseek-api` 的密钥引用
 * 固定为 `KEY_REFS[0]`（智谱凭据），baseURL 随当前监听地址。
 */
export function upsertWebSearchConfig(currentText: string | null, baseURL: string): string {
  const doc = currentText === null ? emptyPatchDoc() : parsePatchDoc(currentText)
  const scanned = scanPatchDoc(doc)
  upsertRow(doc, scanned, webDeepseekApiRow(baseURL))
  upsertRow(doc, scanned, webRow())
  return renderPatchDoc(doc)
}

function upsertRow(doc: Document, scanned: ReturnType<typeof scanPatchDoc>, spec: RowSpec): void {
  // insert 行是用户自建的插件行，不属于覆盖语义；按钮不接管这种形态，明确报错防止写错位置。
  if (scanned.inserts.some((row) => row.id === spec.id)) {
    throw new Error(`patch 中存在 insert 形态的 ${spec.id} 行，请手动调整后重试`)
  }
  // fold 序里后行覆盖前行：取最后一条同名 override 行作为生效行。
  let last: (typeof scanned)['overrides'][number] | undefined
  for (const row of scanned.overrides) {
    if (row.id === spec.id) last = row
  }
  if (last === undefined) {
    const seq = doc.contents
    if (!isSeq(seq)) throw new Error('patch 顶层不是序列，无法追加配置行')
    seq.items.push(doc.createNode({ id: spec.id, name: spec.name, config: spec.config }))
    return
  }
  const entry = doc.getIn([last.patchIndex])
  if (!isMap(entry)) throw new Error(`patch 第 ${last.patchIndex + 1} 项不是映射，无法更新 ${spec.id}`)
  const config = entry.get('config', true)
  if (isMap(config)) {
    // 只写自家键：用户在该行的其他配置键与注释原样保留。
    for (const [key, value] of Object.entries(spec.config)) config.set(key, doc.createNode(value))
  } else {
    entry.set('config', doc.createNode(spec.config))
  }
  // disabled 行不会生效，而按钮语义就是「让它生效」：摘除标记而非写一份无效配置。
  if (entry.get('disabled') === true) entry.delete('disabled')
}
