// Git 安装记录的根级索引；读侧损坏 / 缺失回空，陈旧条目下次写入时自然清理。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitSkillRecord } from './shared'

/** 索引文件名（相对技能根）；dotfile，扫描器只认 .md 与目录包，不会当成技能。 */
export const GIT_INDEX_NAME = '.dsh-skills.json'

/** 索引文件结构（version 预留演进）。 */
export interface RootGitIndex {
  version: 1
  skills: Record<string, GitSkillRecord>
}

/** 记录是否具备最小可用形状（url / dir 为非空字符串）。 */
function isRecord(value: unknown): value is GitSkillRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.url === 'string' && record.url.length > 0 && typeof record.dir === 'string'
}

/** 读取根级索引；缺失 / 损坏 / 形状不对回空索引。 */
export async function readGitIndex(rootPath: string): Promise<RootGitIndex> {
  let raw: string
  try {
    raw = await readFile(join(rootPath, GIT_INDEX_NAME), 'utf8')
  } catch {
    return { version: 1, skills: {} }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, skills: {} }
    const skills = (parsed as { skills?: unknown }).skills
    if (typeof skills !== 'object' || skills === null) return { version: 1, skills: {} }
    const result: Record<string, GitSkillRecord> = {}
    for (const [name, value] of Object.entries(skills as Record<string, unknown>)) {
      if (isRecord(value)) result[name] = value
    }
    return { version: 1, skills: result }
  } catch {
    return { version: 1, skills: {} }
  }
}

/** 覆写根级索引（写前不合并；调用方持有完整新状态；根目录不存在则创建）。 */
export async function writeGitIndex(rootPath: string, index: RootGitIndex): Promise<void> {
  await mkdir(rootPath, { recursive: true })
  await writeFile(join(rootPath, GIT_INDEX_NAME), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}
