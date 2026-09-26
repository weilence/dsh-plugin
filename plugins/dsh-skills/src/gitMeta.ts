/**
 * Git 安装记录的根级索引（host 专用）。
 *
 * 每个可写技能根放一个 `<root>/.dsh-skills.json`：dotfile，扫描器只认
 * `.md` 与目录包，天然不会当成技能。key = 根下的技能目录名（安装时
 * dest = join(root, name)，目录名即技能名），记录源仓库、仓库内路径、
 * 安装时 HEAD 与内容哈希——检查更新与应用更新的全部依据。
 *
 * 读侧对损坏 / 缺失一律回空索引（视为没有 Git 安装记录），不做 GET
 * 期间的写回收；本地目录已不存在的陈旧条目在合并行时被忽略，并在
 * 下一次写入（安装 / 更新 / 删除）时自然清理。
 *
 * @module dsh-skills
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitSkillRecord } from './shared'

/** 索引文件名（相对技能根）。 */
export const GIT_INDEX_NAME = '.dsh-skills.json'

/** 索引文件结构（version 预留演进）。 */
export interface RootGitIndex {
  version: 1
  skills: Record<string, GitSkillRecord>
}

export const EMPTY_GIT_INDEX: RootGitIndex = { version: 1, skills: {} }

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
    return { ...EMPTY_GIT_INDEX, skills: {} }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_GIT_INDEX, skills: {} }
    const skills = (parsed as { skills?: unknown }).skills
    if (typeof skills !== 'object' || skills === null) return { ...EMPTY_GIT_INDEX, skills: {} }
    const result: Record<string, GitSkillRecord> = {}
    for (const [name, value] of Object.entries(skills as Record<string, unknown>)) {
      if (isRecord(value)) result[name] = value
    }
    return { version: 1, skills: result }
  } catch {
    return { ...EMPTY_GIT_INDEX, skills: {} }
  }
}

/** 覆写根级索引（写前不合并；调用方持有完整新状态；根目录不存在则创建）。 */
export async function writeGitIndex(rootPath: string, index: RootGitIndex): Promise<void> {
  await mkdir(rootPath, { recursive: true })
  await writeFile(join(rootPath, GIT_INDEX_NAME), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}
