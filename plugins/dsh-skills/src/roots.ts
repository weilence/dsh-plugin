/**
 * 可写技能根的计算与路径归属（host 专用，node:path / node:fs）。
 *
 * 与官方 skill-filesystem provider 的默认根逻辑对齐：项目根 = 最近的
 * 含 `.git` 祖先（找不到则 cwd 自身）；用户根 = DSH_HOME（或 ~/.dsh）与
 * DSH_AGENTS_HOME（或 ~/.agents）下的 skills 目录。customSkillDirs 与
 * bundledDir 是组合层配置/安装目录，本插件不写入，因此不参与。
 */

import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { RootId, RootInfo } from './shared'

/** 根的展示标签（wire 上的 label）。 */
export const ROOT_LABELS: Record<RootId, string> = {
  'project-dsh': '项目 .dsh/skills',
  'project-agents': '项目 .agents/skills',
  'user-dsh': '用户 ~/.dsh/skills',
  'user-agents': '用户 ~/.agents/skills',
}

/** 一个待判定的可写根（present 标志由调用方补充）。 */
export interface ManagedRoot {
  id: RootId
  path: string
}

/** 用户级 DSH 技能根（$DSH_HOME 或 ~/.dsh 下的 skills）。 */
export function userDshSkillsDir(): string {
  return dshHomePath('skills')
}

/** 用户级共享 agents 技能根（$DSH_AGENTS_HOME 或 ~/.agents 下的 skills）。 */
export function agentsSkillsDir(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 项目根：最近的含 `.git` 的祖先目录；到顶仍无则回 cwd 自身。 */
export async function findProjectRoot(
  cwd: string,
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * 列出当前作用域的全部可写根。cwd 缺席（用户级作用域）时不列项目根，
 * 与官方 provider「cwd 缺席则跳过项目根」的行为一致。
 */
export async function managedRoots(cwd: string | undefined): Promise<ManagedRoot[]> {
  const roots: ManagedRoot[] = []
  if (cwd !== undefined && cwd.length > 0) {
    const projectRoot = await findProjectRoot(resolve(cwd))
    roots.push(
      { id: 'project-dsh', path: join(projectRoot, '.dsh', 'skills') },
      { id: 'project-agents', path: join(projectRoot, '.agents', 'skills') },
    )
  }
  roots.push({ id: 'user-dsh', path: userDshSkillsDir() }, { id: 'user-agents', path: agentsSkillsDir() })
  return roots
}

/** path 是否严格位于 root 之下（不含 root 自身）。 */
export function isUnder(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/** realpath 尽力而为：失败（不存在等）回退 resolve 的字面路径。 */
async function toRealPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** 一次匹配的结果：命中的根 + 实际作为前缀的根路径变体。 */
export interface MatchedRoot {
  root: ManagedRoot
  /** 字面根路径或其 realpath——path（或其 realpath）严格位于其下。 */
  base: string
}

/**
 * 根匹配器：一次性解析全部根的 realpath 变体，此后按「字面 path →
 * realpath path」两级判定，并缓存中途 realpath 结果。官方 provider
 * 下发的技能 path 已经过 realpath，而根路径可能含符号链接（home 重定向、
 * subst 盘符等），因此两侧都做双变体尝试。
 */
export class RootMatcher {
  private readonly variants: readonly { root: ManagedRoot; base: string }[]
  private readonly realPathCache = new Map<string, string>()

  private constructor(variants: readonly { root: ManagedRoot; base: string }[]) {
    this.variants = variants
  }

  static async create(roots: readonly ManagedRoot[]): Promise<RootMatcher> {
    const nested = await Promise.all(
      roots.map(
        async (root) =>
          [
            { root, base: resolve(root.path) },
            { root, base: await toRealPath(root.path) },
          ] as const,
      ),
    )
    return new RootMatcher(nested.flat())
  }

  private async realPathOf(path: string): Promise<string> {
    let real = this.realPathCache.get(path)
    if (real === undefined) {
      real = await toRealPath(path)
      this.realPathCache.set(path, real)
    }
    return real
  }

  /** 判定 path 归属哪个可写根（含命中基座）。 */
  async matchWithBase(path: string): Promise<MatchedRoot | undefined> {
    for (const variant of this.variants) {
      if (isUnder(path, variant.base)) return variant
    }
    const real = await this.realPathOf(path)
    for (const variant of this.variants) {
      if (isUnder(real, variant.base)) return variant
    }
    return undefined
  }

  /** 判定 path 归属哪个可写根（只要根）。 */
  async match(path: string): Promise<ManagedRoot | undefined> {
    return (await this.matchWithBase(path))?.root
  }
}

/** 便捷封装：一次性匹配（测试与低频路径用；列表页请用 RootMatcher）。 */
export async function matchRoot(
  path: string,
  roots: readonly ManagedRoot[],
): Promise<ManagedRoot | undefined> {
  return RootMatcher.create(roots).then((matcher) => matcher.match(path))
}

/** 根目录当前是否存在（目录实体）。 */
export async function isPresentDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 组装 wire 上的 RootInfo 列表。 */
export async function rootInfos(roots: readonly ManagedRoot[]): Promise<RootInfo[]> {
  return Promise.all(
    roots.map(async (root) => ({
      id: root.id,
      label: ROOT_LABELS[root.id],
      path: root.path,
      present: await isPresentDir(root.path),
    })),
  )
}
