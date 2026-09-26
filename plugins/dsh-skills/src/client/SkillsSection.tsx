/**
 * 设置页「Skills 管理」面板：管理范围固定两档——「工作区级」（跟随主视图
 * 会话的工作目录）与「全局」——外加技能目录列表、新建 / 编辑弹窗、删除
 * 确认、Git 安装与更新跟踪。数据经 SkillsStore 与 host 桥交互；面板卸载
 * 时清一次性提示（Toast 计时只在挂载期间有效）。
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, Input, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ConfirmDialog, fieldInputCls } from '@dsh-plugins/client-ui'
import type { GitCheckResult, RootInfo, SkillRow } from '../shared'
import { sourceLabel, sourceOrder } from '../shared'
import type { SkillsStore } from './store'
import { updateKey } from './store'
import { SkillEditor } from './SkillEditor'
import { GitInstallDialog } from './GitInstallDialog'
import shared from '@dsh-plugins/client-ui/styles'
import local from './SkillsSection.module.css'

const styles = { ...shared, ...local }

const MODE_KEY = 'dsh-skills/scope-mode'

/** 仓库地址 → 短标（owner/repo；解析不出回退主机名）。 */
function repoLabelOf(url: string): string {
  try {
    const parsed = new URL(url.replaceAll('\\', '/'))
    const segments = parsed.pathname.split('/').filter((part) => part.length > 0 && part !== ':')
    const repo = segments.pop()?.replace(/\.git$/, '')
    const owner = segments.pop()
    if (repo !== undefined && owner !== undefined) return `${owner}/${repo}`
    if (repo !== undefined) return repo
    return parsed.hostname
  } catch {
    return url
  }
}

/** ISO 时间 → 本地短日期（2025-01-02）。 */
function dateLabelOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 行上的来源 chip 只保留只读来源（内置 / 自定义目录 / 运行时）；四个可写
 *  根的作用域（工作区级 / 全局）由顶部下拉表达，不在行内重复。 */
function readonlyLabelOf(source: string): string | null {
  if (source === 'project-dsh' || source === 'project-agents' || source === 'user-dsh' || source === 'user-agents') {
    return null
  }
  return sourceLabel(source)
}

/** 管理范围档位：工作区级 / 全局，不提供任意目录选择。 */
type ScopeMode = 'user' | 'workspace'

/** 当前主视图工作区的可订阅来源（client.tsx 装配，主会话 cwd 或 undefined）。 */
export interface WorkspaceScopeSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): string | undefined
}

/** 面板注入面（client.tsx 装配，槽位 inject 回调提供）。 */
export interface SkillsPanelEnv {
  store: SkillsStore
  workspace: WorkspaceScopeSource
}

export function SkillsSection(props: SkillsPanelEnv & SettingsSectionOwnerProps) {
  return <SkillsPanel {...props} env={props} />
}

function SkillsPanel(props: SettingsSectionOwnerProps & { env: SkillsPanelEnv }) {
  const store = props.env.store
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => () => store.dismissNotice(), [store])

  // 当前工作区 = 主视图会话（retainedBy.mainView > 0）的 cwd。
  const workspaceCwd = useSyncExternalStore(
    props.env.workspace.subscribe,
    props.env.workspace.getSnapshot,
    props.env.workspace.getSnapshot,
  )

  const [mode, setMode] = useState<ScopeMode>(() => {
    try {
      return window.localStorage.getItem(MODE_KEY) === 'workspace' ? 'workspace' : 'user'
    } catch {
      return 'user'
    }
  })

  // 生效 cwd：工作区档跟随主视图；无主会话时回落用户级。档位或工作区
  // 变化都经 setScope 触发重拉（值未变时 store 内部短路）。
  const effectiveCwd = mode === 'workspace' && workspaceCwd !== undefined ? workspaceCwd : ''
  useEffect(() => {
    store.setScope(effectiveCwd)
  }, [store, effectiveCwd])

  const changeMode = (next: ScopeMode): void => {
    setMode(next)
    setFilter('')
    try {
      window.localStorage.setItem(MODE_KEY, next)
    } catch {
      // 本地存储不可用时档位仅本次会话生效。
    }
  }

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<SkillRow | undefined>(undefined)
  const [viewing, setViewing] = useState<SkillRow | undefined>(undefined)
  const [deleting, setDeleting] = useState<SkillRow | undefined>(undefined)
  const [installing, setInstalling] = useState(false)
  /** 列表过滤关键字（名称 / 描述 / 适用场景，大小写不敏感）。 */
  const [filter, setFilter] = useState('')
  /** 「本地已修改」行的更新需确认（将覆盖本地改动）。 */
  const [confirmUpdate, setConfirmUpdate] = useState<SkillRow | undefined>(undefined)

  const ordered = useMemo(
    () =>
      [...state.skills].sort(
        (left, right) =>
          sourceOrder(left.source) - sourceOrder(right.source) ||
          (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      ),
    [state.skills],
  )

  const keyword = filter.trim().toLowerCase()
  const visible = useMemo(
    () =>
      keyword.length === 0
        ? ordered
        : ordered.filter((skill) =>
            [skill.name, skill.description, skill.whenToUse ?? '']
              .join('\n')
              .toLowerCase()
              .includes(keyword),
          ),
    [ordered, keyword],
  )

  const hasGitSkills = state.skills.some((skill) => skill.git !== undefined)
  const gitWorking = state.gitBusy !== null

  /** 发起单技能更新；「本地已修改」先弹确认。 */
  const requestUpdate = (skill: SkillRow): void => {
    const status = skill.rootId !== undefined ? state.updates[updateKey(skill.rootId, skill.name)] : undefined
    if (status?.status === 'local') {
      setConfirmUpdate(skill)
      return
    }
    if (skill.rootId !== undefined) void store.updateSkills([{ rootId: skill.rootId, name: skill.name }])
  }

  const busy = state.busy !== null || state.loadingFile !== null

  return (
    <div className={styles.panel}>
      <header className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h2 className={styles.panelTitle}>Skills 管理</h2>
          <p className={styles.panelSubtitle}>
            管理工作区级与全局的技能：直接扫描标准技能根（.dsh/skills 与 .agents/skills）并按官方规则校验，
            新建 / 编辑 / 删除技能文件；内置与自定义目录等只读来源仅展示。
          </p>
        </div>
      </header>

      <div className={styles.scopeBar}>
        <label className={styles.scopeField}>
          <span className={styles.label}>管理范围</span>
          <select
            className={styles.select}
            value={mode}
            onChange={(event) => changeMode(event.target.value as ScopeMode)}
          >
            <option value="user">全局</option>
            <option value="workspace" disabled={workspaceCwd === undefined}>
              工作区级
            </option>
          </select>
        </label>
        {mode === 'workspace' ? (
          workspaceCwd !== undefined ? (
            <span className={styles.scopePath} title={workspaceCwd}>
              {workspaceCwd}
            </span>
          ) : (
            <span className={styles.scopeHint}>当前没有打开的工作区会话，先显示全局技能</span>
          )
        ) : null}
      </div>
      <p className={styles.hint}>
        新增、删除技能或修改名称 / 描述后，正在运行的会话会在下一个回复自动收到新目录（约 0.2
        秒稳定窗，无需刷新）；修改正文不重播目录，但下次调用 skill 工具即读到新内容。
      </p>

      {state.error ? (
        <div className={styles.error} role="alert">
          {state.error}
        </div>
      ) : null}
      {state.notice !== null ? (
        <Toast key={state.notice} text={state.notice} holdMs={5000} onDone={() => store.dismissNotice()} />
      ) : null}
      <div className={styles.listToolbar}>
        <Button variant="primary" disabled={state.status !== 'ready'} onClick={() => setCreating(true)}>
          新建技能
        </Button>
        <Button variant="outline" disabled={state.status !== 'ready'} onClick={() => setInstalling(true)}>
          从 Git 安装
        </Button>
        <Button
          variant="outline"
          disabled={!hasGitSkills || gitWorking}
          title={hasGitSkills ? undefined : '当前作用域没有从 Git 安装的技能'}
          onClick={() => void store.checkUpdates()}
        >
          {state.gitBusy === 'check' ? '检查中…' : '检查更新'}
        </Button>
        <Button
          variant="outline"
          disabled={state.status === 'loading' || gitWorking}
          onClick={() => void store.refresh()}
        >
          刷新
        </Button>
      </div>
      {state.status === 'loading' ? <div className={styles.loading}>正在读取技能目录…</div> : null}

      {state.status === 'ready' ? (
        <div className={styles.searchRow}>
          <Input
            className={fieldInputCls(false)}
            type="text"
            value={filter}
            placeholder="搜索过滤：名称 / 描述 / 适用场景"
            autoComplete="off"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      ) : null}

      <div className={styles.rows}>
        {visible.map((skill) => (
          <SkillCard
            key={`${skill.source}:${skill.name}:${skill.path ?? ''}`}
            skill={skill}
            roots={state.roots}
            busy={busy || state.busy === skill.name}
            update={skill.rootId !== undefined ? state.updates[updateKey(skill.rootId, skill.name)] : undefined}
            updating={state.gitBusy === 'update'}
            onView={() => setViewing(skill)}
            onEdit={() => setEditing(skill)}
            onDelete={() => setDeleting(skill)}
            onUpdate={() => requestUpdate(skill)}
          />
        ))}
        {visible.length === 0 && state.status === 'ready' ? (
          <div className={styles.empty}>
            {keyword.length > 0 ? (
              <>没有匹配「{filter.trim()}」的技能</>
            ) : (
              <>
                当前作用域下没有发现技能。工作区级技能放在{' '}
                <code className={styles.code}>.dsh/skills/</code> 或{' '}
                <code className={styles.code}>.agents/skills/</code>，全局技能放在{' '}
                <code className={styles.code}>~/.dsh/skills/</code> 或{' '}
                <code className={styles.code}>~/.agents/skills/</code>；点「新建技能」开始。
              </>
            )}
          </div>
        ) : null}
      </div>

      {creating ? (
        <SkillEditor
          mode="create"
          roots={state.roots}
          skills={state.skills}
          busy={busy}
          error={state.error}
          store={store}
          onCancel={() => setCreating(false)}
        />
      ) : null}
      {installing ? (
        <GitInstallDialog
          store={store}
          roots={state.roots}
          busy={state.gitBusy !== null}
          scanning={state.gitBusy === 'scan'}
          installing={state.gitBusy === 'install'}
          error={state.error}
          onClose={() => setInstalling(false)}
        />
      ) : null}
      {editing !== undefined ? (
        <SkillEditor
          mode="edit"
          skill={editing}
          roots={state.roots}
          skills={state.skills}
          busy={busy}
          error={state.error}
          store={store}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
      {viewing !== undefined ? (
        <SkillEditor
          mode="view"
          skill={viewing}
          roots={state.roots}
          skills={state.skills}
          busy={busy}
          error={state.error}
          store={store}
          onCancel={() => setViewing(undefined)}
        />
      ) : null}

      {deleting !== undefined ? (
        <ConfirmDialog
          title={`删除技能 ${deleting.name}`}
          body={
            deleting.path !== undefined && deleting.path.replaceAll('\\', '/').endsWith('/SKILL.md')
              ? `将删除整个技能目录（含其中的资源文件）：${deleting.path}`
              : `将删除技能文件：${deleting.path ?? ''}`
          }
          confirmLabel="删除"
          busy={busy}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const target = deleting
            setDeleting(undefined)
            void store.remove(target)
          }}
        />
      ) : null}

      {confirmUpdate !== undefined ? (
        <ConfirmDialog
          title={`更新技能 ${confirmUpdate.name}`}
          body={`本地内容在安装后被修改过，更新将用上游版本覆盖本地改动（来源：${confirmUpdate.git?.url ?? ''}）。是否继续？`}
          confirmLabel="覆盖更新"
          busy={gitWorking}
          onCancel={() => setConfirmUpdate(undefined)}
          onConfirm={() => {
            const target = confirmUpdate
            setConfirmUpdate(undefined)
            if (target.rootId !== undefined) {
              void store.updateSkills([{ rootId: target.rootId, name: target.name }])
            }
          }}
        />
      ) : null}
    </div>
  )
}

function SkillCard(props: {
  skill: SkillRow
  roots: readonly RootInfo[]
  busy: boolean
  update?: GitCheckResult
  updating: boolean
  onView(): void
  onEdit(): void
  onDelete(): void
  onUpdate(): void
}) {
  const { skill } = props
  const update = props.update
  return (
    <section className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitleLine}>
          <span className={styles.rowName}>{skill.name}</span>
          {readonlyLabelOf(skill.source) !== null ? (
            <span className={styles.rowSource} title={skill.path}>
              {readonlyLabelOf(skill.source)}
            </span>
          ) : null}
          {skill.git !== undefined ? (
            <span
              className={styles.rowGit}
              title={`Git 安装：${skill.git.url}（${skill.git.dir}，安装于 ${dateLabelOf(skill.git.installedAt)}）`}
            >
              Git · {repoLabelOf(skill.git.url)}
            </span>
          ) : null}
          {update?.status === 'update' ? (
            <span
              className={styles.rowFlagUpdate}
              title={update.description !== undefined ? `上游描述：${update.description}` : '上游有新版本'}
            >
              有更新
            </span>
          ) : null}
          {update?.status === 'local' ? (
            <span className={styles.rowFlagUpdate} title="上游有新版本；本地内容也被修改过，更新将覆盖本地改动">
              有更新 · 本地已修改
            </span>
          ) : null}
          {update?.status === 'removed' ? (
            <span className={styles.rowFlagGone} title="上游仓库里已发现不到该技能目录">
              上游已移除
            </span>
          ) : null}
          {skill.invalid !== undefined ? (
            <span className={styles.rowFlagErr} title={skill.invalid}>
              无效：{skill.invalid}
            </span>
          ) : skill.effective ? null : (
            <span className={styles.rowFlagOff}>被同名来源遮蔽</span>
          )}
          {skill.userInvocable ? null : <span className={styles.rowFlagOff}>用户不可调用</span>}
        </div>
        <p className={styles.rowDesc}>{skill.description.length > 0 ? skill.description : '（无描述）'}</p>
        {skill.whenToUse !== undefined ? <p className={styles.rowWhen}>适用：{skill.whenToUse}</p> : null}
      </div>
      <div className={styles.rowActions}>
        {(update?.status === 'update' || update?.status === 'local') && skill.editable ? (
          <Button variant="outline" size="sm" disabled={props.busy || props.updating} onClick={props.onUpdate}>
            更新
          </Button>
        ) : null}
        {/* 查看：给不可编辑的行（只读来源 / Git 安装）留信息入口；可编辑行用编辑看详情。 */}
        {!skill.editable || skill.git !== undefined ? (
          <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onView}>
            查看
          </Button>
        ) : null}
        {skill.editable && skill.git === undefined ? (
          <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onEdit}>
            编辑
          </Button>
        ) : null}
        {skill.editable ? (
          <Button
            variant="ghost"
            size="sm"
            className={styles.dangerGhost}
            disabled={props.busy}
            onClick={props.onDelete}
          >
            删除
          </Button>
        ) : null}
      </div>
    </section>
  )
}
