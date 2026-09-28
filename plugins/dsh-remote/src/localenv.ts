/**
 * 本机侧的清单读取（host 专用）：skills 两个用户级根的条目扫描、两层
 * 用户 patch 的 MCP 行与插件行扫描。全部只读——本地写管理归 dsh-skills /
 * dsh-mcp，本插件只做同步源。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  MCP_PLUGIN_NAME,
  REMOTE_PLUGIN_NAME,
  type LocalMcpRow,
  type LocalPluginRow,
  type LocalSkillRow,
} from './shared'
import { emptyPatchDoc, parsePatchDoc, scanInserts, type Document, type PatchInsert } from './patchDoc'

/** 用户级 skills 根（与官方 skill-filesystem 的用户根同一逻辑）。 */
export interface SkillsRoot {
  /** manifest 键（连接清单的稳定标识）。 */
  key: 'user-dsh' | 'user-agents'
  path: string
}

export function skillsRoots(env: Record<string, string | undefined> = process.env): SkillsRoot[] {
  return [
    { key: 'user-dsh', path: dshHomePath('skills') },
    { key: 'user-agents', path: resolve(env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills') },
  ]
}

/** 官方发现深度的根扫描：顶层 `<name>/SKILL.md` 目录包与 `<name>.md` 单文件。 */
export async function scanSkillsNames(root: SkillsRoot): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root.path, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    // user-dsh 根的 .system 是官方跳过的系统目录（skipSystem: true）
    if (root.key === 'user-dsh' && entry.name === '.system') continue
    if (entry.isDirectory()) {
      try {
        await stat(join(root.path, entry.name, 'SKILL.md'))
        names.push(entry.name)
      } catch {
        // 目录里没有 SKILL.md：不是官方可发现的技能实体
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      names.push(entry.name.slice(0, -'.md'.length))
    }
  }
  return names.sort()
}

/** frontmatter 的 description 首行值（宽容提取；无 frontmatter / 失败为 null）。 */
async function skillDescription(file: string): Promise<string | null> {
  try {
    const text = await readFile(file, 'utf8')
    if (!text.startsWith('---')) return null
    const end = text.indexOf('\n---', 3)
    if (end === -1) return null
    const match = /^description:[ \t]*(.+)$/m.exec(text.slice(0, end))
    return match === null ? null : match[1].trim().replace(/^['"]|['"]$/g, '')
  } catch {
    return null
  }
}

/** 技能根扫描为 wire 行（名字 + 所在根 + description 摘要），供同步弹窗勾选。 */
export async function scanSkillRows(root: SkillsRoot): Promise<LocalSkillRow[]> {
  const rows: LocalSkillRow[] = []
  for (const name of await scanSkillsNames(root)) {
    // 目录包优先，其次单文件；两者都读不到时 description 为 null（扫描窗口内被删）
    const description =
      (await skillDescription(join(root.path, name, 'SKILL.md'))) ??
      (await skillDescription(`${join(root.path, name)}.md`))
    rows.push({ name, root: root.key, description })
  }
  return rows
}

/** 一层本机 patch 文件（缺失文件给空文档）。 */
export interface LocalPatchLayer {
  source: 'profile' | 'home'
  file: string
  doc: Document
  /** 同目录 package.json 的 dependencies（spec 形态判定本地/registry 的依据）。 */
  deps: Record<string, string>
}

async function readLayer(source: 'profile' | 'home', file: string): Promise<LocalPatchLayer> {
  let text: string | null
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') text = null
    else throw error
  }
  let deps: Record<string, string> = {}
  try {
    const pkg = JSON.parse(await readFile(join(dirname(file), 'package.json'), 'utf8')) as {
      dependencies?: unknown
    }
    if (
      typeof pkg.dependencies === 'object' &&
      pkg.dependencies !== null &&
      !Array.isArray(pkg.dependencies)
    ) {
      deps = Object.fromEntries(
        Object.entries(pkg.dependencies).filter(([, spec]) => typeof spec === 'string'),
      )
    }
  } catch {
    // 层无 package.json（如 home 层未初始化）：按无 spec 处理
  }
  return {
    source,
    file,
    doc: text === null || text.trim().length === 0 ? emptyPatchDoc() : parsePatchDoc(text),
    deps,
  }
}

export interface ProfileContextLike {
  name?: unknown
  patchPath?: unknown
  home?: unknown
}

/** 防御式读取 profileContext（缺席返回 undefined）。 */
export function profileContextOf(ctx: { get(name: string): unknown }):
  | {
      name: string | null
      patchPath: string
      home: string
    }
  | undefined {
  const profile = ctx.get('profileContext') as ProfileContextLike | undefined
  if (profile === undefined || typeof profile.patchPath !== 'string' || typeof profile.home !== 'string') {
    return undefined
  }
  return {
    name: typeof profile.name === 'string' ? profile.name : null,
    patchPath: profile.patchPath,
    home: profile.home,
  }
}

/** 读两层本机 patch（profile 层经 profileContext；home 层兜底 DSH_HOME）。 */
export async function readLocalLayers(
  profile: { patchPath: string; home: string } | undefined,
): Promise<LocalPatchLayer[]> {
  const layers: LocalPatchLayer[] = []
  if (profile !== undefined) layers.push(await readLayer('profile', profile.patchPath))
  layers.push(await readLayer('home', join(profile?.home ?? dshHomePath(), 'cordis.patch.yml')))
  return layers
}

/** fold 出的一条本机 MCP 行。 */
export interface FoldedMcpRow {
  row: PatchInsert
  config: Record<string, unknown>
  disabled: boolean
}

/** MCP 行的 fold：先按序收集全部裸覆盖（后层覆盖前层），再套到 insert 上。 */
export function foldMcpRows(layers: readonly LocalPatchLayer[]): FoldedMcpRow[] {
  const overrides = new Map<string, { config?: Record<string, unknown>; disabled?: boolean }>()
  for (const layer of layers) {
    const composed = layer.doc.toJS({ mapAsMap: false })
    if (!Array.isArray(composed)) continue
    for (const item of composed) {
      const record =
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : undefined
      if (record === undefined || record.insert !== undefined || typeof record.id !== 'string') continue
      const current = overrides.get(record.id) ?? {}
      if (typeof record.config === 'object' && record.config !== null && !Array.isArray(record.config)) {
        current.config = record.config as Record<string, unknown>
      }
      if (typeof record.disabled === 'boolean') current.disabled = record.disabled
      overrides.set(record.id, current)
    }
  }
  const byId = new Map<string, FoldedMcpRow>()
  for (const layer of layers) {
    for (const insert of scanInserts(layer.doc)) {
      if (insert.name !== MCP_PLUGIN_NAME) continue
      const base =
        typeof insert.config === 'object' && insert.config !== null && !Array.isArray(insert.config)
          ? (insert.config as Record<string, unknown>)
          : {}
      const override = overrides.get(insert.id)
      byId.set(insert.id, {
        row: insert,
        config: { ...base, ...(override?.config ?? {}) },
        disabled: override?.disabled ?? insert.disabled === true,
      })
    }
  }
  return [...byId.values()]
}

function mcpSummary(config: Record<string, unknown>): string {
  if (config.transport === 'stdio') {
    const command = typeof config.command === 'string' ? config.command : ''
    const args = Array.isArray(config.args) ? config.args.join(' ') : ''
    return [command, args].filter((part) => part.length > 0).join(' ') || 'stdio'
  }
  if (typeof config.url === 'string') return config.url
  return typeof config.transport === 'string' ? config.transport : '未声明传输'
}

/** 本地路径安装的 spec 前缀（pnpm 的 link: / file: 协议）。 */
const LOCAL_SPEC_PATTERN = /^(link|file):/i

async function readPackageVersion(root: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * 一条插件行的安装形态与包定位：层 dependencies 的 link:/file: spec 指向本地
 * 目录；registry 依赖的包实体在层内 node_modules（.pnpm 虚拟 store 的 symlink
 * 目标，打包前须 realpath）。定位失败保留名字，安装时按形态分流或报错。
 */
async function pluginRowMeta(
  layer: LocalPatchLayer,
  name: string,
): Promise<Pick<LocalPluginRow, 'install' | 'root' | 'version'>> {
  const spec = layer.deps[name]
  if (spec !== undefined && LOCAL_SPEC_PATTERN.test(spec)) {
    const target = spec.slice(spec.indexOf(':') + 1).trim()
    // file: 允许相对层目录；link: pnpm 一律写绝对路径
    const root =
      spec.slice(0, spec.indexOf(':')).toLowerCase() === 'file'
        ? resolve(dirname(layer.file), target)
        : target
    return { install: 'local', root, version: await readPackageVersion(root) }
  }
  const root = join(dirname(layer.file), 'node_modules', name)
  const version = await readPackageVersion(root)
  return { install: 'registry', root: version === null ? null : root, version }
}

/** 组装 wire 上的本机清单（MCP 行 + 插件行）。 */
export async function composeLocalRows(layers: readonly LocalPatchLayer[]): Promise<{
  mcpRows: LocalMcpRow[]
  pluginRows: LocalPluginRow[]
}> {
  const mcpRows: LocalMcpRow[] = foldMcpRows(layers).map(({ row, config }) => ({
    id: row.id,
    serverName:
      typeof config.serverName === 'string' && config.serverName.length > 0 ? config.serverName : null,
    summary: mcpSummary(config),
  }))
  mcpRows.sort((left, right) => ((left.serverName ?? left.id) < (right.serverName ?? right.id) ? -1 : 1))

  const pluginRows: LocalPluginRow[] = []
  const seen = new Set<string>()
  for (const layer of layers) {
    for (const insert of scanInserts(layer.doc)) {
      if (insert.name === MCP_PLUGIN_NAME) continue
      // 本插件自身是远端默认基线，不进同步清单；旧裸名行在改名重装前的
      // 过渡期一并排除，防止把自己当成业务插件同步出去。
      if (insert.name === REMOTE_PLUGIN_NAME || insert.name === 'dsh-remote') continue
      const dedupe = insert.name
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      pluginRows.push({
        id: insert.id,
        name: insert.name,
        source: layer.source,
        ...(await pluginRowMeta(layer, insert.name)),
      })
    }
  }
  pluginRows.sort((left, right) => left.name.localeCompare(right.name))
  return { mcpRows, pluginRows }
}
