/**
 * 从 Git 仓库安装技能（host 专用）：部分克隆 + 稀疏检出（只物化技能
 * 相关目录）、仓库内技能发现、整目录复制进目标可写根。
 *
 * 拉取用 `git clone --depth 1 --filter=blob:none --sparse` 起步（只检出
 * 仓库根文件），再 `sparse-checkout set skills .agents/skills
 * .claude/skills .claude-plugin` 物化标准位置，并根据 marketplace /
 * plugin 清单补充声明的插件目录——docs、src 等其余内容不落盘。服务器
 * 不支持 blob 过滤时 git 自动降级（整包浅克隆）；本地 git 过旧不认识
 * 这些参数时回退普通 `--depth 1` 克隆。
 *
 * 发现规则对齐社区事实标准（vercel-labs/skills CLI 的仓库内发现）：
 * ① `.claude-plugin/marketplace.json`（或单插件仓库的 plugin.json）声明
 * 的技能路径与插件目录下的标准位置；② 仓库根 SKILL.md 与标准容器
 * （skills/、.agents/skills/、.claude/skills/），容器内最多下探 3 层，
 * 浅层 SKILL.md 遮蔽深层。安装即整目录复制（保留 references / scripts /
 * assets），同名冲突拒绝不覆盖。
 *
 * @module dsh-skills
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SKILL_NAME_PATTERN, type GitSkillCandidate } from './shared'
import { parseSkillFile } from './scan'
import type { ManagedRoot } from './roots'

const CLONE_TIMEOUT_MS = 120_000
const MAX_FILES_PER_SKILL = 500
const MAX_BYTES_PER_SKILL = 20 * 1024 * 1024

/** scp 风格远程地址（git@github.com:owner/repo.git）。 */
const SCP_LIKE_PATTERN = /^[\w.-]+@[\w.-]+:[\w./~-]+?(?:\.git)?$/

/** 校验 git 远程地址；合法返回 null，否则返回中文错误。 */
export function gitUrlProblem(url: string): string | null {
  const trimmed = url.trim()
  if (trimmed.length === 0) return '仓库地址不能为空'
  if (/\s/.test(trimmed)) return '仓库地址不能包含空白字符'
  if (
    trimmed.startsWith('file://') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  ) {
    return '不支持本地路径与 file:// 地址（仅 https / ssh 远程）'
  }
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('ssh://')) {
    try {
      new URL(trimmed)
      return null
    } catch {
      return '不是合法的 URL'
    }
  }
  if (SCP_LIKE_PATTERN.test(trimmed)) return null
  return '无法识别的 git 地址（支持 https:// 、ssh:// 与 git@host:owner/repo 形式）'
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      rejectRun(new Error('git clone 超时（120 秒）'))
    }, CLONE_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      rejectRun(
        error.code === 'ENOENT'
          ? new Error('未找到 git 可执行文件：请先安装 git 并加入 PATH')
          : new Error(`无法启动 git：${error.message}`),
      )
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveRun(stdout.trim())
      else
        rejectRun(
          new Error(
            `git clone 失败：${stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `退出码 ${code}`}`,
          ),
        )
    })
  })
}

/** 浅克隆起步时物化的标准位置（仓库根文件随 --sparse 自带）。 */
const SPARSE_BASE_DIRS = ['skills', '.agents/skills', '.claude/skills', '.claude-plugin'] as const

/**
 * 从 marketplace / plugin 清单算出需要补充物化的插件目录（相对仓库根，
 * posix 分隔）。必须在发现前跑：插件目录不在标准集合里，不补就看不见。
 */
async function declaredPluginDirs(repo: string): Promise<string[]> {
  const marketplaceDoc = asRecord(await readJsonFile(join(repo, '.claude-plugin', 'marketplace.json')))
  const pluginDoc =
    marketplaceDoc === undefined
      ? asRecord(await readJsonFile(join(repo, '.claude-plugin', 'plugin.json')))
      : undefined
  if (marketplaceDoc === undefined && pluginDoc === undefined) return []
  const pluginRoot =
    marketplaceDoc !== undefined
      ? typeof (asRecord(marketplaceDoc.metadata) ?? {}).pluginRoot === 'string'
        ? (asRecord(marketplaceDoc.metadata) as { pluginRoot: string }).pluginRoot
        : './plugins'
      : '.'
  const entries: unknown[] =
    marketplaceDoc !== undefined && Array.isArray(marketplaceDoc.plugins)
      ? marketplaceDoc.plugins
      : pluginDoc !== undefined
        ? [pluginDoc]
        : []
  const dirs = new Set<string>()
  for (const entry of entries) {
    const plugin = asRecord(entry)
    if (plugin === undefined || typeof plugin.source !== 'string') continue
    const rel =
      plugin.source.startsWith('./') || plugin.source.startsWith('../')
        ? plugin.source
        : `${pluginRoot}/${plugin.source}`
    const cleaned = rel
      .split(/[\\/]/)
      .filter((part) => part.length > 0 && part !== '.' && part !== '..')
      .join('/')
    if (cleaned.length > 0) dirs.add(cleaned)
  }
  return [...dirs]
}

/**
 * 部分克隆 + 稀疏检出（只物化技能相关目录）到临时目录；失败自清理并
 * 抛错（消息面向用户）。旧 git 不认识 --sparse / --filter 时回退整仓
 * 浅克隆，两次都失败报告首个错误。
 */
export async function cloneToTemp(url: string): Promise<string> {
  const dest = await mkdtemp(join(tmpdir(), 'dsh-skills-'))
  const trimmed = url.trim()
  try {
    await runGit(
      ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--quiet', '--', trimmed, dest],
      dest,
    )
    await runGit(['sparse-checkout', 'set', ...SPARSE_BASE_DIRS], dest)
    const extra = await declaredPluginDirs(dest)
    if (extra.length > 0) await runGit(['sparse-checkout', 'add', ...extra], dest)
    return dest
  } catch (error) {
    await rm(dest, { recursive: true, force: true })
    try {
      await runGit(['clone', '--depth', '1', '--quiet', '--', trimmed, dest], dest)
      return dest
    } catch {
      await rm(dest, { recursive: true, force: true })
      throw error
    }
  }
}

/** 仓库当前 HEAD 提交号（浅克隆也有）；不可得时回 undefined（更新检查退化为内容比对）。 */
export async function headCommit(repo: string): Promise<string | undefined> {
  try {
    const sha = await runGit(['rev-parse', 'HEAD'], repo)
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
  } catch {
    return undefined
  }
}

/**
 * 技能目录的内容指纹：按 posix 相对路径排序，逐文件 sha256 内容哈希，
 * 再对「路径 + 文件哈希」序列做总哈希。与 mtime / 检出时间无关，
 * 安装基线与当前目录之间可直接比对（检出本地修改的依据）。
 */
export async function treeHash(dir: string): Promise<string> {
  const lines: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const entry of entries) {
      if (entry.name === '.git') continue
      // 与复制规则一致：符号链接一律跳过。
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), `${prefix}${entry.name}/`)
        continue
      }
      if (!entry.isFile()) continue
      const content = await readFile(join(current, entry.name))
      lines.push(`${prefix}${entry.name} ${createHash('sha256').update(content).digest('hex')}`)
    }
  }
  await walk(dir, '')
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex')
}

// ---- 仓库内发现 ----

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function toPosix(rel: string): string {
  return rel.split(sep).join('/')
}

/** path 严格位于 base 之下或等于 base。 */
function isUnderOrEqual(base: string, path: string): boolean {
  const rel = relative(resolve(base), resolve(path))
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** 目录含 SKILL.md 时返回其绝对路径。 */
async function skillMdOf(dir: string): Promise<string | undefined> {
  const candidate = join(dir, 'SKILL.md')
  return (await isFile(candidate)) ? candidate : undefined
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

type Collector = (dirAbs: string, origin: GitSkillCandidate['origin']) => void

/** 容器目录下发现技能：子目录含 SKILL.md 即命中且不再下探，否则继续
 * 下探（最多 3 层，覆盖 skills/<category>/<name> 分类布局）。 */
async function scanContainer(
  container: string,
  origin: GitSkillCandidate['origin'],
  add: Collector,
): Promise<void> {
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const child = join(dir, entry.name)
      if ((await skillMdOf(child)) !== undefined) add(child, origin)
      else await walk(child, depth + 1)
    }
  }
  await walk(container, 1)
}

/** 读取技能目录的 SKILL.md 并按官方规则校验，产出候选行。 */
async function candidateOf(
  root: string,
  dirAbs: string,
  origin: GitSkillCandidate['origin'],
): Promise<GitSkillCandidate> {
  let raw = ''
  try {
    raw = await readFile(join(dirAbs, 'SKILL.md'), { encoding: 'utf8' })
  } catch {
    // 入表前已确认存在；竞态缺失按空文本文案处理。
  }
  const parsed = parseSkillFile(raw, basename(dirAbs))
  const rel = relative(root, dirAbs)
  return {
    dir: rel.length === 0 ? '.' : toPosix(rel),
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined && parsed.whenToUse.length > 0 ? { whenToUse: parsed.whenToUse } : {}),
    origin,
    ...(parsed.invalid !== undefined ? { problem: parsed.invalid } : {}),
  }
}

/** 扫描克隆出来的仓库，产出全部技能候选与仓库级提示。 */
export async function discoverRepoSkills(
  root: string,
): Promise<{ skills: GitSkillCandidate[]; notes: string[] }> {
  const notes: string[] = []
  const found = new Map<string, GitSkillCandidate['origin']>()
  const add: Collector = (dirAbs, origin) => {
    const key = resolve(dirAbs)
    if (!found.has(key)) found.set(key, origin)
  }

  // ① Claude 插件市场清单：声明的插件目录与技能路径。
  const marketplaceDoc = asRecord(await readJsonFile(join(root, '.claude-plugin', 'marketplace.json')))
  const pluginDoc =
    marketplaceDoc === undefined
      ? asRecord(await readJsonFile(join(root, '.claude-plugin', 'plugin.json')))
      : undefined
  if (marketplaceDoc !== undefined || pluginDoc !== undefined) {
    const pluginRoot =
      marketplaceDoc !== undefined
        ? typeof (asRecord(marketplaceDoc.metadata) ?? {}).pluginRoot === 'string'
          ? (asRecord(marketplaceDoc.metadata) as { pluginRoot: string }).pluginRoot
          : './plugins'
        : '.'
    const entries: unknown[] =
      marketplaceDoc !== undefined
        ? Array.isArray(marketplaceDoc.plugins)
          ? marketplaceDoc.plugins
          : []
        : [pluginDoc]
    for (const entry of entries) {
      const plugin = asRecord(entry)
      if (plugin === undefined) continue
      const label = typeof plugin.name === 'string' && plugin.name.length > 0 ? plugin.name : '（未命名插件）'
      let pluginDir: string | undefined
      if (typeof plugin.source === 'string') {
        pluginDir =
          plugin.source.startsWith('./') || plugin.source.startsWith('../')
            ? resolve(root, plugin.source)
            : resolve(root, pluginRoot, plugin.source)
      } else if (pluginDoc !== undefined) {
        pluginDir = root
      } else {
        notes.push(`跳过插件 ${label}：source 不是仓库内相对路径（远程 / npm 插件暂不支持）`)
        continue
      }
      if (!isUnderOrEqual(root, pluginDir)) {
        notes.push(`跳过插件 ${label}：source 路径越出仓库`)
        continue
      }
      const origin: GitSkillCandidate['origin'] = marketplaceDoc !== undefined ? 'marketplace' : 'plugin'
      if (Array.isArray(plugin.skills)) {
        for (const declared of plugin.skills) {
          if (typeof declared !== 'string') continue
          const dir = resolve(pluginDir, declared)
          if (!isUnderOrEqual(pluginDir, dir)) continue
          if ((await skillMdOf(dir)) !== undefined) add(dir, origin)
        }
      }
      if ((await skillMdOf(pluginDir)) !== undefined) add(pluginDir, origin)
      await scanContainer(join(pluginDir, 'skills'), origin, add)
    }
  }

  // ② 标准位置：仓库根单技能 + 三个技能容器。
  if ((await skillMdOf(root)) !== undefined) add(root, 'root')
  await scanContainer(join(root, 'skills'), 'skills', add)
  await scanContainer(join(root, '.agents', 'skills'), 'agents', add)
  await scanContainer(join(root, '.claude', 'skills'), 'claude', add)

  const skills = await Promise.all([...found].map(([dirAbs, origin]) => candidateOf(root, dirAbs, origin)))
  skills.sort((left, right) => (left.dir < right.dir ? -1 : left.dir > right.dir ? 1 : 0))
  return { skills, notes }
}

// ---- 安装（整目录复制） ----

export interface GitInstallOutcome {
  installed: { name: string; path: string }[]
  conflicts: { name: string; path: string }[]
  failed: { name: string; error: string }[]
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function copyTree(from: string, to: string): Promise<void> {
  let files = 0
  let bytes = 0
  const walk = async (source: string, dest: string): Promise<void> => {
    const entries = await readdir(source, { withFileTypes: true })
    await mkdir(dest, { recursive: true })
    for (const entry of entries) {
      if (entry.name === '.git') continue
      // 符号链接一律跳过：目标可能越出技能目录或是断链。
      if (entry.isSymbolicLink()) continue
      const sourceChild = join(source, entry.name)
      const destChild = join(dest, entry.name)
      if (entry.isDirectory()) {
        await walk(sourceChild, destChild)
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      if (files > MAX_FILES_PER_SKILL) throw new Error(`文件数超过上限（${MAX_FILES_PER_SKILL}）`)
      const info = await stat(sourceChild)
      bytes += info.size
      if (bytes > MAX_BYTES_PER_SKILL) throw new Error(`总体积超过上限（20 MiB）`)
      await copyFile(sourceChild, destChild)
    }
  }
  await walk(from, to)
}

/** 把选中的候选整目录复制进目标根；同名冲突拒绝，失败清理半成品。 */
export async function installCandidates(
  target: ManagedRoot,
  candidates: readonly GitSkillCandidate[],
  sourceRoot: string,
): Promise<GitInstallOutcome> {
  const installed: { name: string; path: string }[] = []
  const conflicts: { name: string; path: string }[] = []
  const failed: { name: string; error: string }[] = []
  for (const candidate of candidates) {
    if (candidate.problem !== undefined) {
      failed.push({ name: candidate.name, error: candidate.problem })
      continue
    }
    if (!SKILL_NAME_PATTERN.test(candidate.name)) {
      failed.push({ name: candidate.name, error: `名称「${candidate.name}」不合法（需 kebab-case）` })
      continue
    }
    const sourceDir = resolve(sourceRoot, ...candidate.dir.split('/'))
    if (!isUnderOrEqual(sourceRoot, sourceDir) || (await skillMdOf(sourceDir)) === undefined) {
      failed.push({ name: candidate.name, error: '仓库里未找到该技能目录（内容可能已变化），请重新扫描' })
      continue
    }
    const dest = join(target.path, candidate.name)
    if (await pathExists(dest)) {
      conflicts.push({ name: candidate.name, path: dest })
      continue
    }
    try {
      await copyTree(sourceDir, dest)
      installed.push({ name: candidate.name, path: dest })
    } catch (error) {
      await rm(dest, { recursive: true, force: true })
      failed.push({ name: candidate.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { installed, conflicts, failed }
}
