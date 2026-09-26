/**
 * 设置页「Skills 管理」面板：管理范围固定两档——「当前工作区 + 用户级」
 * （自动跟随主视图会话的工作目录）与「用户级（全局）」——外加技能目录
 * 列表、新建 / 编辑 / 查看弹窗与删除确认。数据经 SkillsStore 与 host
 * 桥交互；面板卸载时清一次性提示（Toast 计时只在挂载期间有效）。
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ConfirmDialog, ToneChip } from '@dsh-plugins/client-ui'
import type { RootInfo, SkillRow } from '../shared'
import { sourceLabel, sourceOrder } from '../shared'
import type { SkillsStore } from './store'
import { SkillEditor } from './SkillEditor'
import shared from '@dsh-plugins/client-ui/styles'
import local from './SkillsSection.module.css'

const styles = { ...shared, ...local }

const MODE_KEY = 'dsh-skills/scope-mode'

/** 管理范围档位：仅当前工作区 + 全局，不提供任意目录选择。 */
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

  const ordered = useMemo(
    () =>
      [...state.skills].sort(
        (left, right) =>
          sourceOrder(left.source) - sourceOrder(right.source) ||
          (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      ),
    [state.skills],
  )

  const busy = state.busy !== null || state.loadingFile !== null

  return (
    <div className={styles.panel}>
      <header className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h2 className={styles.panelTitle}>Skills 管理</h2>
          <p className={styles.panelSubtitle}>
            管理当前工作区与用户级（全局）的技能：直接扫描标准技能根并按官方规则校验， 新建 / 编辑 /
            删除技能文件；内置与自定义目录等只读来源仅查看。
          </p>
        </div>
        <div className={styles.headActions}>
          <Button variant="primary" disabled={state.status !== 'ready'} onClick={() => setCreating(true)}>
            新建技能
          </Button>
          <Button
            variant="outline"
            disabled={state.status === 'loading'}
            onClick={() => void store.refresh()}
          >
            刷新
          </Button>
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
            <option value="user">用户级（全局技能）</option>
            <option value="workspace" disabled={workspaceCwd === undefined}>
              当前工作区 + 用户级
            </option>
          </select>
        </label>
        {mode === 'workspace' ? (
          workspaceCwd !== undefined ? (
            <span className={styles.scopePath} title={workspaceCwd}>
              {workspaceCwd}
            </span>
          ) : (
            <span className={styles.scopeHint}>当前没有打开的工作区会话，先显示用户级技能</span>
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
      {state.status === 'loading' ? <div className={styles.loading}>正在读取技能目录…</div> : null}

      <div className={styles.rows}>
        {ordered.map((skill) => (
          <SkillCard
            key={`${skill.source}:${skill.name}:${skill.path ?? ''}`}
            skill={skill}
            roots={state.roots}
            busy={busy || state.busy === skill.name}
            onView={() => setViewing(skill)}
            onEdit={() => setEditing(skill)}
            onDelete={() => setDeleting(skill)}
          />
        ))}
        {ordered.length === 0 && state.status === 'ready' ? (
          <div className={styles.empty}>
            当前作用域下没有发现技能。项目级技能放在{' '}
            <code className={styles.code}>.dsh/skills/&lt;name&gt;.md</code>，用户级放在{' '}
            <code className={styles.code}>~/.dsh/skills/</code>；点「新建技能」开始。
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
    </div>
  )
}

function SkillCard(props: {
  skill: SkillRow
  roots: readonly RootInfo[]
  busy: boolean
  onView(): void
  onEdit(): void
  onDelete(): void
}) {
  const { skill } = props
  return (
    <section className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitleLine}>
          <span className={styles.rowName}>{skill.name}</span>
          <span className={styles.rowSource}>{sourceLabel(skill.source)}</span>
          {skill.invalid !== undefined ? (
            <span className={styles.rowFlagErr} title={skill.invalid}>
              无效：{skill.invalid}
            </span>
          ) : skill.effective ? (
            <span className={styles.rowFlagOn}>生效中</span>
          ) : (
            <span className={styles.rowFlagOff}>被同名来源遮蔽</span>
          )}
          {skill.modelInvocable ? null : <span className={styles.rowFlagOff}>模型不可调用</span>}
          {skill.userInvocable ? null : <span className={styles.rowFlagOff}>用户不可调用</span>}
        </div>
        <p className={styles.rowDesc}>{skill.description.length > 0 ? skill.description : '（无描述）'}</p>
        {skill.whenToUse !== undefined ? <p className={styles.rowWhen}>适用：{skill.whenToUse}</p> : null}
        {skill.path !== undefined ? (
          <p className={styles.rowPath} title={skill.path}>
            {skill.path}
          </p>
        ) : (
          <p className={styles.rowPath}>（虚拟技能，无文件）</p>
        )}
      </div>
      <div className={styles.rowActions}>
        {skill.editable ? <ToneChip tone="ok">可编辑</ToneChip> : <ToneChip tone="warn">只读</ToneChip>}
        <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onView}>
          查看
        </Button>
        {skill.editable ? (
          <>
            <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onEdit}>
              编辑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.dangerGhost}
              disabled={props.busy}
              onClick={props.onDelete}
            >
              删除
            </Button>
          </>
        ) : null}
      </div>
    </section>
  )
}
