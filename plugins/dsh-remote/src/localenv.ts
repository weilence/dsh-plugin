// 本机清单只读扫描；本地写管理归 dsh-skills / dsh-mcp。
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  MCP_PLUGIN_NAME,
  isRemoteSelf,
  mcpSignature,
  type LocalMcpRow,
  type LocalPluginRow,
  type LocalPromptRow,
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

/** 用户级全局提示词文件（AGENTS.md）——dsh-prompts 插件管理的同一文件。
 *  home 取 profileContext.home（$DSH_HOME）；dsh-agent-instructions 单独覆写
 *  dshHome 时无法读到（宿主无公开接口），与 dsh-prompts 同一限制。 */
export function globalPromptFile(home: string): string {
  return join(home, 'AGENTS.md')
}

/** 扫描本机全局提示词行（弹窗展示与判等用）；文件不存在 digest 为 null。 */
export async function scanGlobalPrompt(home: string): Promise<LocalPromptRow> {
  const path = globalPromptFile(home)
  try {
    return { path, digest: await fileHash(path) }
  } catch {
    return { path, digest: null }
  }
}

/** 官方发现深度的根扫描：顶层 `<name>/SKILL.md` 目录包与 `<name>.md` 单文件。 */
export async function scanSkillsNames(root: SkillsRoot): Promise<string[]> {
  let entries: Dirent[]
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

/** 折叠一个技能全部文件的摘要行 → 单一内容指纹。本机扫描与远端
 *  `find | sha256sum` 输出共用此折叠（收集规则两侧镜像：POSIX 相对路径、
 *  跳过 '.' 开头路径段、目录包与 `<name>.md` 单文件并集），保证同内容必同指纹。 */
export function foldSkillDigest(files: readonly { path: string; hash: string }[]): string {
  const material = [...files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((file) => `${file.path}\0${file.hash}\0`)
    .join('')
  return createHash('sha256').update(material).digest('hex')
}

async function fileHash(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

/** 打包与包指纹共用的目录排除段（单一来源）：packPackage 的拷贝过滤与此同表，
 *  保证「指纹所见的文件集 === 打进 tgz 的文件集」。 */
export const PACKAGE_PACK_EXCLUDED: readonly string[] = ['node_modules', '.git']

/** 打包与双端指纹共用的忽略规则：排除段之外，另跳过 ._ 前缀条目——macOS
 *  AppleDouble（tar 对扩展属性的序列化副产物、Finder 网络卷遗留），不是包
 *  内容。曾因宿主内 tar 序列化 provenance xattr 令远端已装指纹永远对不上。 */
export function isPackJunkSegment(segment: string): boolean {
  return PACKAGE_PACK_EXCLUDED.includes(segment) || segment.startsWith('._')
}

/** 插件包根的内容指纹：整树逐文件 sha256 后折叠（与远端 node -e 管线镜像——
 *  '/' 连接的相对路径、同一忽略规则、符号链接不计），同内容必同指纹。刻意不比
 *  mtime / 权限：声明语义只关心内容字节。读不到（定位失败 / 文件不可读）回
 *  null——同步侧按「无法比对」保守重装。 */
export async function packageTreeDigest(root: string): Promise<string | null> {
  const files: { path: string; hash: string }[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (isPackJunkSegment(entry.name)) continue
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${rel}/`)
      else if (entry.isFile()) files.push({ path: rel, hash: await fileHash(join(dir, entry.name)) })
    }
  }
  try {
    await walk(await realpath(root), '')
    return foldSkillDigest(files)
  } catch {
    return null
  }
}

/** 插件 payload 的内容寻址文件名：dsh profile 固定 nodeLinker: hoisted，其下
 *  pnpm add 只认 specifier 变化——同 name@version 换内容若沿用旧文件名，远端
 *  会以 Already up to date 跳过重新解包（--force 也绕不过）；指纹入名使内容
 *  变化必然改变 specifier。 */
export function payloadFileName(name: string, version: string, digest: string): string {
  return `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}-${digest.slice(0, 8)}.tgz`
}

/** 一个技能的文件摘要行：目录包递归 + `<name>.md` 单文件（两者并存取并集，
 *  镜像远端整根 find 的视角）；隐藏段跳过（对齐官方发现层对 '.' 的跳过）。 */
async function skillFileHashes(root: SkillsRoot, name: string): Promise<{ path: string; hash: string }[]> {
  const files: { path: string; hash: string }[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在（单文件技能）或扫描窗口内消失：无目录文件可计
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${rel}/`)
      else if (entry.isFile()) files.push({ path: rel, hash: await fileHash(join(dir, entry.name)) })
    }
  }
  await walk(join(root.path, name), `${name}/`)
  try {
    files.push({ path: `${name}.md`, hash: await fileHash(`${join(root.path, name)}.md`) })
  } catch {
    // 无单文件形态（目录包技能的常态）
  }
  return files
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

/** 技能根扫描为 wire 行（名字 + 所在根 + description 摘要 + 内容指纹），供同步弹窗勾选。 */
export async function scanSkillRows(root: SkillsRoot): Promise<LocalSkillRow[]> {
  const rows: LocalSkillRow[] = []
  for (const name of await scanSkillsNames(root)) {
    // 目录包优先，其次单文件；两者都读不到时 description 为 null（扫描窗口内被删）
    const description =
      (await skillDescription(join(root.path, name, 'SKILL.md'))) ??
      (await skillDescription(`${join(root.path, name)}.md`))
    let digest: string | null
    try {
      digest = foldSkillDigest(await skillFileHashes(root, name))
    } catch {
      // 扫描窗口内被删等：按无法比对处理（同步侧保守推送）
      digest = null
    }
    rows.push({ name, root: root.key, description, digest })
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
  /** 同目录 package.json 的 dsh.profile.bundles——本机插件的主要登记处（link 安装
   *  等多数插件不走 patch insert 行，只有 bundles + dependencies）。 */
  bundles?: string[]
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
  let bundles: string[] | undefined
  try {
    const pkg = JSON.parse(await readFile(join(dirname(file), 'package.json'), 'utf8')) as {
      dependencies?: unknown
      dsh?: { profile?: { bundles?: unknown } } | undefined
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
    if (Array.isArray(pkg.dsh?.profile?.bundles)) {
      bundles = (pkg.dsh?.profile?.bundles as unknown[]).filter(
        (name): name is string => typeof name === 'string' && name.length > 0,
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
    bundles,
  }
}

export interface ProfileContextLike {
  name?: unknown
  patchPath?: unknown
  home?: unknown
}

/** 防御式读取 profileContext（不可用时返回 undefined）。 */
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

/** 读两层本机 patch（profile 层经 profileContext；home 层回退到 DSH_HOME）。 */
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

/** MCP 行的 fold：先按序收集全部覆盖行（后层覆盖前层），再套到 insert 上。 */
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

export function mcpSummary(config: Record<string, unknown>): string {
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
): Promise<Pick<LocalPluginRow, 'install' | 'root' | 'version' | 'digest'>> {
  const spec = layer.deps[name]
  if (spec !== undefined && LOCAL_SPEC_PATTERN.test(spec)) {
    const target = spec.slice(spec.indexOf(':') + 1).trim()
    // file: 允许相对层目录；link: pnpm 一律写绝对路径
    const root =
      spec.slice(0, spec.indexOf(':')).toLowerCase() === 'file'
        ? resolve(dirname(layer.file), target)
        : target
    return {
      install: 'local',
      root,
      version: await readPackageVersion(root),
      digest: await packageTreeDigest(root),
    }
  }
  const root = join(dirname(layer.file), 'node_modules', name)
  const version = await readPackageVersion(root)
  return {
    install: 'registry',
    root: version === null ? null : root,
    version,
    digest: version === null ? null : await packageTreeDigest(root),
  }
}

/** 组装 wire 上的本机清单（MCP 行 + 插件行）。 */
export async function composeLocalRows(layers: readonly LocalPatchLayer[]): Promise<{
  mcpRows: LocalMcpRow[]
  pluginRows: LocalPluginRow[]
}> {
  const mcpRows: LocalMcpRow[] = foldMcpRows(layers).map(({ row, config, disabled }) => ({
    id: row.id,
    serverName:
      typeof config.serverName === 'string' && config.serverName.length > 0 ? config.serverName : null,
    summary: mcpSummary(config),
    signature: mcpSignature(config, disabled),
  }))
  mcpRows.sort((left, right) => ((left.serverName ?? left.id) < (right.serverName ?? right.id) ? -1 : 1))

  const pluginRows: LocalPluginRow[] = []
  const seen = new Set<string>()
  for (const layer of layers) {
    for (const insert of scanInserts(layer.doc)) {
      if (insert.name === MCP_PLUGIN_NAME) continue
      // 本插件自身是远端装配基线（isRemoteSelf），不进同步清单
      if (isRemoteSelf(insert.name)) continue
      if (seen.has(insert.name)) continue
      seen.add(insert.name)
      pluginRows.push({
        id: insert.id,
        name: insert.name,
        source: layer.source,
        ...(await pluginRowMeta(layer, insert.name)),
      })
    }
    // bundles 激活清单是本机插件的主要登记处（link 安装无 patch 行）；
    // @deepseek-ai/* 是随 dsh 对齐安装的平台自带包，不进同步清单。
    for (const name of layer.bundles ?? []) {
      if (isRemoteSelf(name) || name.startsWith('@deepseek-ai/') || seen.has(name)) continue
      seen.add(name)
      pluginRows.push({
        id: name,
        name,
        source: layer.source,
        ...(await pluginRowMeta(layer, name)),
      })
    }
  }
  pluginRows.sort((left, right) => left.name.localeCompare(right.name))
  return { mcpRows, pluginRows }
}
