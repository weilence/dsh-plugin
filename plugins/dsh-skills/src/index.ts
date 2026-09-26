/**
 * dsh-skills host half：设置页「Skills 管理」面板的 HTTP 桥。
 *
 * 官方 web/desktop 组合刻意禁用 host 级 skill-filesystem（本地发现由各
 * agent preset 的 scoped 层负责），全局 `ctx.skills` 注册表默认为空，
 * 因此读侧以「直接扫描四个标准技能根」为主（与官方 provider 同一套
 * 发现与校验规则），并集上全局注册表里落在这四个根之外的条目（内置 /
 * 自定义目录 / 运行时技能）作只读展示。写侧直接落盘（node:fs），
 * frontmatter 只做行级已知键替换，未知字段原样保留；删除只作用于归属
 * 可写根的单文件 / 目录包。
 *
 * @module dsh-skills
 */

import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import {
  SKILL_NAME_PATTERN,
  sourceOrder,
  type DeleteRequest,
  type FileResponse,
  type GitCheckRequest,
  type GitInstallRequest,
  type GitScanRequest,
  type GitSkillCandidate,
  type GitUpdateRequest,
  type ListResponse,
  type RootId,
  type SaveRequest,
  type SaveResponse,
  type SkillFormat,
  type SkillRow,
} from './shared'
import { applyKnown, formatOfPath, renderFile, splitFrontmatter } from './frontmatter'
import { cloneToTemp, discoverRepoSkills, gitUrlProblem, installCandidates } from './gitInstall'
import { readGitIndex, writeGitIndex, type RootGitIndex } from './gitMeta'
import { applyGitUpdates, checkGitUpdates, recordInstalls } from './gitUpdate'
import { RootMatcher, managedRoots, rootInfos, type ManagedRoot } from './roots'
import { scanRoot } from './scan'
// 栅栏函数与 JSON 桥读写来自共享包（构建期内联）；HttpError 为路由与
// readJsonBody 共用的业务错误类型，同一模块实例保证 instanceof 语义。
import { HttpError, isExpectedHost, isTrustedFetch, readJsonBody, writeJson } from '@dsh-plugins/shared/http'

export const inject: string[] = ['webServer']

export const LIST_PATH = '/dsh-skills/list'
export const FILE_PATH = '/dsh-skills/file'
export const SAVE_PATH = '/dsh-skills/save'
export const DELETE_PATH = '/dsh-skills/delete'
export const GIT_SCAN_PATH = '/dsh-skills/git-scan'
export const GIT_INSTALL_PATH = '/dsh-skills/git-install'
export const GIT_CHECK_PATH = '/dsh-skills/git-check'
export const GIT_UPDATE_PATH = '/dsh-skills/git-update'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 解析查询里的 cwd：空白或缺席 = 全局作用域。 */
function cwdOf(value: string | null): string | undefined {
  return optionalString(value)
}

/** 作用域过滤：workspace 只留项目根，user（缺省）只留用户根——两档互斥。 */
function scopeRoots(roots: readonly ManagedRoot[], workspace: boolean): ManagedRoot[] {
  return roots.filter((root) => (workspace ? root.id.startsWith('project-') : root.id.startsWith('user-')))
}

function skillRowOf(
  summary: {
    name: string
    description: string
    whenToUse?: string
    invocation: { modelInvocable: boolean; userInvocable: boolean }
    source: string
    provider: string
    path?: string
    invalid?: string
    format?: SkillFormat
  },
  rootId: string | undefined,
  effective: boolean,
): SkillRow {
  return {
    name: summary.name,
    description: summary.description,
    ...(summary.whenToUse !== undefined ? { whenToUse: summary.whenToUse } : {}),
    modelInvocable: summary.invocation.modelInvocable,
    userInvocable: summary.invocation.userInvocable,
    source: summary.source,
    provider: summary.provider,
    ...(summary.path !== undefined ? { path: summary.path } : {}),
    ...(rootId !== undefined ? { rootId: rootId as SkillRow['rootId'] } : {}),
    ...(summary.format !== undefined ? { format: summary.format } : {}),
    ...(summary.invalid !== undefined ? { invalid: summary.invalid } : {}),
    editable: rootId !== undefined,
    effective,
  }
}

export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: LIST_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'GET') {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const url = new URL(req.url ?? '/', 'http://localhost')
            const cwd = cwdOf(url.searchParams.get('cwd'))
            const workspace = url.searchParams.get('scope') === 'workspace'
            const roots = scopeRoots(await managedRoots(cwd), workspace)
            const scanned = (await Promise.all(roots.map((root) => scanRoot(root)))).flat()
            const rows: SkillRow[] = scanned.map((skill) =>
              skillRowOf({ ...skill, provider: 'scan' }, skill.source, false),
            )
            // 全局注册表补充：落在四个可写根之外的条目（内置 / 自定义 /
            // 运行时）作只读展示；另一档作用域的可写根条目随作用域一并隐藏。
            // 注册表缺席（组合未挂载）时跳过。
            const registry = ctx.get('skills')
            if (registry !== undefined) {
              const seenPaths = new Set(rows.map((row) => row.path))
              const snapshot = await registry.snapshot(cwd === undefined ? {} : { cwd })
              for (const summary of snapshot.skills) {
                if (summary.path === undefined || seenPaths.has(summary.path)) continue
                const otherScope = workspace
                  ? summary.source.startsWith('user-')
                  : summary.source.startsWith('project-')
                if (otherScope) continue
                seenPaths.add(summary.path)
                rows.push(skillRowOf(summary, undefined, false))
              }
            }
            // Git 安装来源合并：目录包行按「根下目录名」查根级索引（安装
            // 时 dest = join(root, name)，目录名即技能名）；索引陈旧条目
            // （目录已被外部删掉）自然不命中。
            const gitIndexes = new Map<RootId, RootGitIndex>()
            await Promise.all(
              roots.map(async (root) => gitIndexes.set(root.id, await readGitIndex(root.path))),
            )
            for (const row of rows) {
              if (row.rootId === undefined || row.format !== 'bundle' || row.path === undefined) continue
              const record = gitIndexes.get(row.rootId)?.skills[basename(dirname(row.path))]
              if (record === undefined) continue
              row.git = {
                url: record.url,
                dir: record.dir,
                ...(record.commit !== undefined ? { commit: record.commit.slice(0, 7) } : {}),
                installedAt: record.installedAt,
              }
            }
            // 遮蔽判定在合并全集上做：同名合法条目按来源 rank 取最低者为
            // 胜（custom 300 会盖过用户级 400/500，正如官方注册表的规则）。
            const winnerPath = new Map<string, string>()
            for (const row of [...rows].sort(
              (left, right) => sourceOrder(left.source) - sourceOrder(right.source),
            )) {
              if (row.invalid !== undefined) continue
              if (!winnerPath.has(row.name)) winnerPath.set(row.name, row.path ?? row.name)
            }
            for (const row of rows) {
              row.effective = row.invalid === undefined && winnerPath.get(row.name) === (row.path ?? row.name)
            }
            rows.sort(
              (left, right) =>
                sourceOrder(left.source) - sourceOrder(right.source) ||
                (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
            )
            const response: ListResponse = {
              roots: await rootInfos(roots),
              skills: rows,
            }
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, 500, { error: String(error) })
          }
        },
      }),
    'dsh-skills: list bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: FILE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'GET') {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const url = new URL(req.url ?? '/', 'http://localhost')
            const path = optionalString(url.searchParams.get('path'))
            if (path === undefined) {
              writeJson(res, 400, { error: '缺少 path 参数' })
              return
            }
            const cwd = cwdOf(url.searchParams.get('cwd'))
            const roots = await managedRoots(cwd)
            const matcher = await RootMatcher.create(roots)
            let allowed = (await matcher.match(path)) !== undefined
            if (!allowed) {
              // 只读来源（bundled / custom）按当前目录快照放行精确匹配的路径。
              const registry = ctx.get('skills')
              const snapshot =
                registry === undefined ? undefined : await registry.snapshot(cwd === undefined ? {} : { cwd })
              allowed = snapshot?.skills.some((skill) => skill.path === path) === true
            }
            if (!allowed) {
              writeJson(res, 403, { error: '该文件不在可管理的技能路径内' })
              return
            }
            let raw: string
            try {
              raw = await readFile(path, { encoding: 'utf8' })
            } catch {
              writeJson(res, 404, { error: '技能文件不存在或不可读' })
              return
            }
            const response: FileResponse = { path, raw }
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            writeJson(res, 500, { error: String(error) })
          }
        },
      }),
    'dsh-skills: file bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SAVE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as SaveRequest
            const cwd = optionalString(request.cwd)
            const roots = await managedRoots(cwd)
            const matcher = await RootMatcher.create(roots)

            const name = typeof request.name === 'string' ? request.name : ''
            if (!SKILL_NAME_PATTERN.test(name)) {
              throw new HttpError(400, `技能名称「${name}」不合法：需为 kebab-case（小写字母数字与连字符）`)
            }
            const description = typeof request.description === 'string' ? request.description.trim() : ''
            if (description.length === 0) throw new HttpError(400, '描述不能为空')
            const whenToUse = optionalString(request.whenToUse)
            const draft = {
              name,
              description,
              ...(whenToUse !== undefined ? { whenToUse } : {}),
              modelInvocable: optionalBoolean(request.modelInvocable, true),
              userInvocable: optionalBoolean(request.userInvocable, true),
            }
            const skillBody = typeof request.body === 'string' ? request.body : ''
            const editPath = optionalString(request.editPath)

            let target: string
            if (editPath !== undefined) {
              // 编辑模式：只覆盖 list 下发的原路径；名称不可变（frontmatter
              // 与文件名一致由创建保证，编辑改名会让两者漂移）。
              if ((await matcher.match(editPath)) === undefined) {
                throw new HttpError(403, '该文件不在可管理的技能根内')
              }
              const existingName = await frontmatterNameOf(editPath)
              if (existingName !== undefined && existingName !== name) {
                throw new HttpError(400, `编辑时不能改名（当前文件声明的名称是「${existingName}」）`)
              }
              let existing = ''
              try {
                existing = await readFile(editPath, { encoding: 'utf8' })
              } catch {
                throw new HttpError(404, '原技能文件不存在（可能已被外部删除），请刷新')
              }
              const split = splitFrontmatter(existing) ?? { fm: '', body: existing }
              const fm = applyKnown(split.fm, draft)
              target = editPath
              if (formatOfPath(target) === 'bundle') await mkdir(dirname(target), { recursive: true })
              await writeFile(target, renderFile(fm, skillBody), { encoding: 'utf8' })
            } else {
              // 新建模式：目标根内不得存在同名单文件或同名目录（两者互相遮蔽）。
              const rootId = request.rootId as RootId
              const root = roots.find((candidate) => candidate.id === rootId)
              if (root === undefined) throw new HttpError(400, `未知的目标根「${String(rootId)}」`)
              const format = request.format === 'bundle' ? 'bundle' : 'flat'
              const flatPath = join(root.path, `${name}.md`)
              const bundlePath = join(root.path, name, 'SKILL.md')
              for (const candidate of [flatPath, bundlePath]) {
                if (await pathExists(candidate)) {
                  throw new HttpError(409, `目标根已存在同名技能：${candidate}`)
                }
              }
              target = format === 'bundle' ? bundlePath : flatPath
              if (format === 'bundle') await mkdir(dirname(target), { recursive: true })
              else await mkdir(root.path, { recursive: true })
              await writeFile(target, renderFile(applyKnown('', draft), skillBody), { encoding: 'utf8' })
            }
            const response: SaveResponse = { path: target }
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: String(error instanceof Error ? error.message : error) })
          }
        },
      }),
    'dsh-skills: save bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DELETE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as DeleteRequest
            const path = optionalString(request.path)
            if (path === undefined) throw new HttpError(400, '缺少 path')
            const cwd = optionalString(request.cwd)
            const roots = await managedRoots(cwd)
            const matcher = await RootMatcher.create(roots)
            const matched = await matcher.matchWithBase(path)
            if (matched === undefined) throw new HttpError(403, '该文件不在可管理的技能根内')
            // 形态校验：根下单文件（<name>.md）或目录包（<name>/SKILL.md），
            // 更深的路径不是官方可发现的技能实体，拒绝删除以免误伤资源目录。
            // 以实际命中的基座变体（字面或 realpath）计算相对路径。
            const rel = relative(matched.base, path)
              .split(/[\\/]/)
              .filter((segment) => segment.length > 0)
            const base = basename(path)
            if (rel.length === 1 && base.endsWith('.md')) {
              try {
                await unlink(path)
              } catch {
                throw new HttpError(404, '技能文件不存在（可能已被外部删除），请刷新')
              }
            } else if (rel.length === 2 && rel[1] === 'SKILL.md') {
              try {
                await rm(dirname(path), { recursive: true })
              } catch {
                throw new HttpError(404, '技能目录不存在（可能已被外部删除），请刷新')
              }
              // Git 安装的目录包：同步摘除根索引里的来源记录。
              const name = basename(dirname(path))
              const index = await readGitIndex(matched.root.path)
              if (index.skills[name] !== undefined) {
                delete index.skills[name]
                await writeGitIndex(matched.root.path, index)
              }
            } else {
              throw new HttpError(400, `不是可删除的技能实体：${rel.join(sep)}`)
            }
            writeJson(res, 200, { removed: true })
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: String(error instanceof Error ? error.message : error) })
          }
        },
      }),
    'dsh-skills: delete bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: GIT_SCAN_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          let temp: string | undefined
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as GitScanRequest
            const url = optionalString(request.url)
            if (url === undefined) throw new HttpError(400, '缺少仓库地址')
            const problem = gitUrlProblem(url)
            if (problem !== null) throw new HttpError(400, problem)
            try {
              temp = await cloneToTemp(url)
            } catch (error) {
              throw new HttpError(400, error instanceof Error ? error.message : String(error))
            }
            const { skills, notes } = await discoverRepoSkills(temp)
            writeJson(res, 200, { skills, notes })
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: String(error instanceof Error ? error.message : error) })
          } finally {
            if (temp !== undefined) await rm(temp, { recursive: true, force: true })
          }
        },
      }),
    'dsh-skills: git-scan bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: GIT_INSTALL_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          let temp: string | undefined
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as GitInstallRequest
            const url = optionalString(request.url)
            if (url === undefined) throw new HttpError(400, '缺少仓库地址')
            const problem = gitUrlProblem(url)
            if (problem !== null) throw new HttpError(400, problem)
            const dirs = Array.isArray(request.skills)
              ? request.skills.filter((dir): dir is string => typeof dir === 'string')
              : []
            if (dirs.length === 0) throw new HttpError(400, '未选择任何技能')
            const cwd = optionalString(request.cwd)
            const roots = await managedRoots(cwd)
            const target = roots.find((root) => root.id === request.rootId)
            if (target === undefined) throw new HttpError(400, `未知的目标根「${String(request.rootId)}」`)
            try {
              temp = await cloneToTemp(url)
            } catch (error) {
              throw new HttpError(400, error instanceof Error ? error.message : String(error))
            }
            const { skills: candidates } = await discoverRepoSkills(temp)
            const byDir = new Map<string, GitSkillCandidate>(candidates.map((skill) => [skill.dir, skill]))
            const selected: GitSkillCandidate[] = dirs.map((dir) => {
              const found = byDir.get(dir)
              if (found !== undefined) return found
              return {
                dir,
                name: dir.split('/').pop() ?? dir,
                description: '',
                origin: 'skills',
                problem: '仓库里未找到该技能（内容可能已变化），请重新扫描',
              }
            })
            const outcome = await installCandidates(target, selected, temp)
            // 复制成功即登记来源（commit + 内容哈希），供后续检查更新回指。
            const installedNames = outcome.installed.map((row) => row.name)
            if (installedNames.length > 0) {
              await recordInstalls(target.path, url, temp, selected, installedNames)
            }
            writeJson(res, 200, outcome as unknown as Record<string, unknown>)
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: String(error instanceof Error ? error.message : error) })
          } finally {
            if (temp !== undefined) await rm(temp, { recursive: true, force: true })
          }
        },
      }),
    'dsh-skills: git-install bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: GIT_CHECK_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as GitCheckRequest
            const cwd = optionalString(request.cwd)
            const roots = scopeRoots(await managedRoots(cwd), request.scope === 'workspace')
            const response = await checkGitUpdates(roots)
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: String(error instanceof Error ? error.message : error) })
          }
        },
      }),
    'dsh-skills: git-check bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: GIT_UPDATE_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (!isExpectedHost(req, ctx.webServer.host) || req.method !== 'POST' || !isTrustedFetch(req)) {
              writeJson(res, 403, { error: 'forbidden' })
              return
            }
            const body = await readJsonBody(req)
            const request = body as unknown as GitUpdateRequest
            const skills = Array.isArray(request.skills)
              ? request.skills.filter(
                  (item): item is { rootId: RootId; name: string } =>
                    typeof item === 'object' &&
                    item !== null &&
                    typeof (item as { name?: unknown }).name === 'string',
                )
              : []
            if (skills.length === 0) throw new HttpError(400, '未选择任何技能')
            const cwd = optionalString(request.cwd)
            const roots = scopeRoots(await managedRoots(cwd), request.scope === 'workspace')
            const response = await applyGitUpdates(roots, skills)
            writeJson(res, 200, response as unknown as Record<string, unknown>)
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            writeJson(res, status, { error: String(error instanceof Error ? error.message : error) })
          }
        },
      }),
    'dsh-skills: git-update bridge',
  )
}

/** 读取现有文件的 frontmatter name（缺文件 / 缺键返回 undefined）。 */
async function frontmatterNameOf(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, { encoding: 'utf8' })
    const split = splitFrontmatter(raw)
    if (split === undefined) return undefined
    const text = /^name:[ \t]+(.*)$/.exec(
      split.fm.split(/\r?\n/).find((line) => line.startsWith('name:')) ?? '',
    )?.[1]
    if (text === undefined) return undefined
    const trimmed = text.trim().replace(/^['"]|['"]$/g, '')
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}
