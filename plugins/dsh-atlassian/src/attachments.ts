import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'

/**
 * Jira 附件的本地缓存：派生数据（可重下、可手删），按官方 cache 语义落
 * `$DSH_HOME/cache/dsh-atlassian/attachments`，不进工作区、不碰宿主内部结构。
 */

/** 默认缓存根；buildTools 的 options 可注入替代目录供测试与用户定制。 */
export function defaultAttachmentsRoot(): string {
  return dshCachePath('dsh-atlassian', 'attachments')
}

/**
 * 文件名消毒：路径分隔符与控制字符全部替换为下划线，杜绝目录穿越；
 * 空名回落 attachment，超长截断（保留末尾扩展名的意图交给 id 前缀保证唯一）。
 */
export function sanitizeFilename(name: string): string {
  const safe = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').trim()
  const usable = safe === '' || safe === '.' || safe === '..' ? 'attachment' : safe
  return usable.length > 120 ? usable.slice(0, 120) : usable
}

/** 缓存文件名：附件 id 前缀保证唯一（同 id 重名直接覆盖，即缓存刷新语义）。 */
export function attachmentPath(root: string, id: string, filename: string): string {
  return join(root, `${sanitizeFilename(id)}-${sanitizeFilename(filename)}`)
}

/** tmp + rename 原子落盘（仓库惯例：文件写盘不半途可见）。 */
export async function saveAttachment(
  root: string,
  id: string,
  filename: string,
  data: Buffer,
): Promise<string> {
  const final = attachmentPath(root, id, filename)
  await mkdir(dirname(final), { recursive: true })
  const tmp = `${final}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, data)
  await rename(tmp, final)
  return final
}
