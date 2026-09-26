/**
 * Git 安装技能的更新跟踪（host 专用）。
 *
 * 依据各根的 .dsh-skills.json 索引（gitMeta）把已安装技能回指到源
 * 仓库，同一仓库只克隆一次：
 *
 * - 检查（checkGitUpdates）：commit 快路径——记录的 HEAD 即当前 HEAD
 *   直接判「已最新」；否则重发现仓库，按目录内容哈希逐技能判定
 *   update（上游变了、本地未动）/ local（两侧都变，更新会覆盖本地
 *   改动）/ removed（上游已移除）。
 * - 应用（applyGitUpdates）：staging 目录复制 → 原子换名覆盖，成功后
 *   刷新索引里的 commit / 内容哈希 / 时间。
 * - 登记（recordInstalls）：git-install 成功后由桥调用，把来源写进索引。
 *
 * @module dsh-skills
 */

import { rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  GitCheckResponse,
  GitCheckResult,
  GitSkillCandidate,
  GitSkillRecord,
  GitUpdateResponse,
  RootId,
} from './shared'
import { cloneToTemp, copyTree, discoverRepoSkills, headCommit, treeHash } from './gitInstall'
import { readGitIndex, writeGitIndex, type RootGitIndex } from './gitMeta'
import type { ManagedRoot } from './roots'

/** 索引里的仓库内路径（'.' 允许，= 仓库根单技能）→ 仓库内绝对路径。 */
function repoDir(repo: string, dir: string): string {
  return dir === '.' ? repo : resolve(repo, ...dir.split('/'))
}

/**
 * 把一次成功安装 / 更新的技能写进根索引（git-install 桥在复制成功后、
 * 清理临时克隆前调用）。picked = 全部候选（带 dir / origin），installed
 * = 实际落地的技能名。
 */
export async function recordInstalls(
  rootPath: string,
  url: string,
  temp: string,
  picked: readonly GitSkillCandidate[],
  installed: readonly string[],
): Promise<void> {
  if (installed.length === 0) return
  const index = await readGitIndex(rootPath)
  const commit = await headCommit(temp)
  const installedSet = new Set(installed)
  for (const candidate of picked) {
    if (!installedSet.has(candidate.name)) continue
    index.skills[candidate.name] = {
      url,
      dir: candidate.dir,
      origin: candidate.origin,
      ...(commit !== undefined ? { commit } : {}),
      contentHash: await treeHash(repoDir(temp, candidate.dir)),
      installedAt: new Date().toISOString(),
    }
  }
  await writeGitIndex(rootPath, index)
}

/** 一个被跟踪的已安装技能。 */
interface TrackedSkill {
  root: ManagedRoot
  name: string
  record: GitSkillRecord
}

/** 根据目录是否存在判断路径是否为目录（失败视为不存在）。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 收集全部索引记录仍指向现存目录的被跟踪技能。 */
async function trackedSkills(roots: readonly ManagedRoot[]): Promise<TrackedSkill[]> {
  const tracked: TrackedSkill[] = []
  for (const root of roots) {
    const index = await readGitIndex(root.path)
    for (const [name, record] of Object.entries(index.skills)) {
      if (await isDirectory(join(root.path, name))) tracked.push({ root, name, record })
    }
  }
  return tracked
}

/** 按源仓库地址分组（每仓库只克隆一次），保持进入顺序。 */
function groupByUrl(tracked: readonly TrackedSkill[]): Map<string, TrackedSkill[]> {
  const byUrl = new Map<string, TrackedSkill[]>()
  for (const entry of tracked) {
    const group = byUrl.get(entry.record.url)
    if (group === undefined) byUrl.set(entry.record.url, [entry])
    else group.push(entry)
  }
  return byUrl
}

/** 检查当前作用域全部 Git 安装技能的更新状态。 */
export async function checkGitUpdates(roots: readonly ManagedRoot[]): Promise<GitCheckResponse> {
  const results: GitCheckResult[] = []
  const repoErrors: { url: string; error: string }[] = []
  for (const [url, group] of groupByUrl(await trackedSkills(roots))) {
    let temp: string | undefined
    try {
      temp = await cloneToTemp(url)
    } catch (error) {
      repoErrors.push({ url, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    try {
      const head = await headCommit(temp)
      // commit 快路径：全部条目的记录 commit 即当前 HEAD 时无需发现与哈希。
      const needDiscover = group.some((entry) => entry.record.commit !== head)
      const byDir = needDiscover
        ? new Map((await discoverRepoSkills(temp)).skills.map((skill) => [skill.dir, skill]))
        : new Map<string, GitSkillCandidate>()
      for (const { root, name, record } of group) {
        if (record.commit !== undefined && record.commit === head) {
          results.push({ rootId: root.id, name, dir: record.dir, status: 'current' })
          continue
        }
        const candidate = byDir.get(record.dir)
        if (candidate === undefined) {
          results.push({ rootId: root.id, name, dir: record.dir, status: 'removed' })
          continue
        }
        const [fresh, local] = await Promise.all([
          treeHash(repoDir(temp, record.dir)),
          treeHash(join(root.path, name)),
        ])
        const status =
          local === fresh
            ? 'current'
            : record.contentHash === undefined || local === record.contentHash
              ? 'update'
              : 'local'
        results.push({
          rootId: root.id,
          name,
          dir: record.dir,
          status,
          ...(candidate.description.length > 0 ? { description: candidate.description } : {}),
        })
      }
    } finally {
      if (temp !== undefined) await rm(temp, { recursive: true, force: true })
    }
  }
  results.sort(
    (left, right) =>
      left.rootId.localeCompare(right.rootId) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  )
  return { results, repoErrors }
}

/** 应用更新：staging 复制 → 原子换名覆盖，成功后刷新根索引。 */
export async function applyGitUpdates(
  roots: readonly ManagedRoot[],
  items: readonly { rootId: RootId; name: string }[],
): Promise<GitUpdateResponse> {
  const updated: { name: string; path: string }[] = []
  const failed: { name: string; error: string }[] = []
  const repoErrors: { url: string; error: string }[] = []

  const resolved: TrackedSkill[] = []
  for (const item of items) {
    const root = roots.find((candidate) => candidate.id === item.rootId)
    if (root === undefined) {
      failed.push({ name: item.name, error: `未知的目标根「${item.rootId}」` })
      continue
    }
    const record = (await readGitIndex(root.path)).skills[item.name]
    if (record === undefined) {
      failed.push({ name: item.name, error: '没有该技能的 Git 安装记录' })
      continue
    }
    resolved.push({ root, name: item.name, record })
  }

  for (const [url, group] of groupByUrl(resolved)) {
    let temp: string | undefined
    try {
      temp = await cloneToTemp(url)
    } catch (error) {
      repoErrors.push({ url, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    try {
      const byDir = new Map((await discoverRepoSkills(temp)).skills.map((skill) => [skill.dir, skill]))
      const head = await headCommit(temp)
      // 同一根可能命中多条，聚合后一次写回。
      const touched = new Map<string, RootGitIndex>()
      for (const { root, name, record } of group) {
        const sourceDir = repoDir(temp, record.dir)
        const candidate = byDir.get(record.dir)
        const dest = join(root.path, name)
        if (candidate === undefined) {
          failed.push({ name, error: '上游仓库里已找不到该技能目录' })
          continue
        }
        // staging 复制成功才移除旧目录：复制失败时本地技能原样保留。
        const staging = join(root.path, `${name}.dsh-update`)
        try {
          const hash = await treeHash(sourceDir)
          await rm(staging, { recursive: true, force: true })
          await copyTree(sourceDir, staging)
          await rm(dest, { recursive: true, force: true })
          await rename(staging, dest)
          const index = touched.get(root.path) ?? (await readGitIndex(root.path))
          index.skills[name] = {
            url,
            dir: record.dir,
            origin: record.origin,
            ...(head !== undefined ? { commit: head } : {}),
            contentHash: hash,
            installedAt: new Date().toISOString(),
          }
          touched.set(root.path, index)
          updated.push({ name, path: join(dest, 'SKILL.md') })
        } catch (error) {
          await rm(staging, { recursive: true, force: true })
          failed.push({ name, error: error instanceof Error ? error.message : String(error) })
        }
      }
      for (const [rootPath, index] of touched) await writeGitIndex(rootPath, index)
    } finally {
      if (temp !== undefined) await rm(temp, { recursive: true, force: true })
    }
  }
  return { updated, failed, repoErrors }
}
