import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RootId, SkillFormat } from './shared'
import { SKILL_NAME_PATTERN } from './shared'
import { parseKnown, splitFrontmatter } from './frontmatter'
import type { ManagedRoot } from './roots'

/** 一个扫描出的技能条目（含校验结果）。 */
export interface ScannedSkill {
  /** frontmatter 声明的名称；无效条目回退文件名主干。 */
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  source: RootId
  path: string
  format: SkillFormat
  /** 校验失败原因；缺席 = 合法条目。 */
  invalid?: string
}

interface RootEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'other'
}

async function listEntries(rootPath: string): Promise<RootEntry[]> {
  let entries
  try {
    entries = await readdir(rootPath, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    // 根不存在或不可读 = 空根（与官方 provider 的缺席语义一致）。
    return []
  }
  const result: RootEntry[] = []
  for (const entry of entries) {
    const path = join(rootPath, entry.name)
    const type = await entryType(path, entry)
    result.push({ name: entry.name, path, type })
  }
  return result
}

async function entryType(
  path: string,
  entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean },
): Promise<RootEntry['type']> {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  // 符号链接按目标实体分类；其他特殊文件跳过。
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
  } catch {
    // 断链或不可 stat：跳过。
  }
  return 'other'
}

/** 解析并按官方规则校验一个技能文件。 */
export function parseSkillFile(
  raw: string,
  fallbackName: string,
): Omit<ScannedSkill, 'source' | 'path' | 'format'> {
  const split = splitFrontmatter(raw)
  if (split === undefined) {
    return {
      name: fallbackName,
      description: '',
      invocation: DEFAULT_INVOCATION,
      invalid: '缺少 YAML frontmatter（需以 --- 开始的元信息块）',
    }
  }
  const known = parseKnown(split.fm)
  if (hasLegacyInvocationKey(split.fm)) {
    return {
      name: known.name ?? fallbackName,
      description: known.description ?? '',
      invocation: invocationOf(known),
      invalid: '包含不受支持的调用策略键（请改用 disable-model-invocation / user-invocable）',
    }
  }
  const name = known.name
  if (name === undefined || !SKILL_NAME_PATTERN.test(name)) {
    return {
      name: fallbackName,
      description: known.description ?? '',
      invocation: invocationOf(known),
      invalid: `缺少合法的 name（kebab-case）：${name ?? '（缺失）'}`,
    }
  }
  if (known.description === undefined || known.description.length === 0) {
    return { name, description: '', invocation: invocationOf(known), invalid: '缺少 description' }
  }
  return {
    name,
    description: known.description,
    whenToUse: known.whenToUse || undefined,
    invocation: invocationOf(known),
  }
}

const DEFAULT_INVOCATION = { modelInvocable: true, userInvocable: true }

function invocationOf(known: ReturnType<typeof parseKnown>): {
  modelInvocable: boolean
  userInvocable: boolean
} {
  return {
    modelInvocable: known.disableModelInvocation !== true,
    userInvocable: known.userInvocable !== false,
  }
}

/** 官方 parser 拒绝的旧版调用策略键：出现即整个文件不可用。 */
function hasLegacyInvocationKey(fm: string): boolean {
  return fm
    .split(/\r?\n/)
    .some((line) => /^(disableModelInvocation|modelInvocable|userInvocable):/.test(line))
}

/** 扫描一个根目录，产出全部条目（含无效条目）。 */
export async function scanRoot(root: ManagedRoot): Promise<ScannedSkill[]> {
  const skills: ScannedSkill[] = []
  const entries = (await listEntries(root.path)).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
  for (const entry of entries) {
    if (root.id === 'user-dsh' && entry.name === '.system') continue
    let filePath: string | undefined
    let format: SkillFormat = 'flat'
    if (entry.type === 'directory') {
      filePath = join(entry.path, 'SKILL.md')
      format = 'bundle'
    } else if (entry.type === 'file' && entry.name.endsWith('.md')) {
      filePath = entry.path
    } else {
      continue
    }
    let raw: string
    try {
      raw = await readFile(filePath, { encoding: 'utf8' })
    } catch {
      // 目录包缺 SKILL.md：不是技能，静默跳过（与官方 provider 一致）。
      continue
    }
    const fallback = entry.type === 'directory' ? entry.name : entry.name.replace(/\.md$/, '')
    skills.push({ ...parseSkillFile(raw, fallback), source: root.id, path: filePath, format })
  }
  return skills
}
