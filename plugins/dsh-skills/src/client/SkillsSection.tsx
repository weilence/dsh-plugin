import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Input, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CardList,
  ConfirmDialog,
  ExpandableCard,
  Panel,
  SelectField,
  useWideSettingsDialog,
  fieldInputCls,
} from '@dsh-plugins/client-ui'
import type { SkillRow } from '../shared'
import { sourceOrder } from '../shared'
import type { SkillsStore } from './store'
import { updateKey } from './store'
import type { SkillsT } from './locales'
import { sourceLabelT } from './locales'
import { SkillForm, SkillView } from './SkillForm'
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
function readonlyLabelOf(source: string, t: SkillsT): string | null {
  if (
    source === 'project-dsh' ||
    source === 'project-agents' ||
    source === 'user-dsh' ||
    source === 'user-agents'
  ) {
    return null
  }
  return sourceLabelT(source, t)
}

/**
 * 词典插值只出字符串；空态文案里的目录路径要保留 <code> 样式与可复制性，
 * 这里按 `{name}` 占位符把模板切成片段后拼 ReactNode。
 */
function interpolateNodes(template: string, params: Record<string, ReactNode>): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const index = match.index ?? 0
    if (index > cursor) nodes.push(template.slice(cursor, index))
    nodes.push(params[match[1]] ?? match[0])
    cursor = index + match[0].length
  }
  if (cursor < template.length) nodes.push(template.slice(cursor))
  return nodes
}

/** 管理范围档位：工作区级 / 全局，不提供任意目录选择。 */
type ScopeMode = 'user' | 'workspace'

/** 当前主视图工作区的可订阅来源（client.tsx 装配，主会话 cwd 或 undefined）。 */
export interface WorkspaceScopeSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): string | undefined
}

/** 面板注入面（client.tsx 装配，槽位 inject 回调提供；t 是 locale 声明的框架标准 seat）。 */
export interface SkillsPanelEnv {
  store: SkillsStore
  workspace: WorkspaceScopeSource
}

export function SkillsSection(props: SkillsPanelEnv & SettingsSectionOwnerProps & { t: SkillsT }) {
  useWideSettingsDialog()
  return <SkillsPanel {...props} env={props} />
}

function SkillsPanel(props: SettingsSectionOwnerProps & { env: SkillsPanelEnv; t: SkillsT }) {
  const { store } = props.env
  const { t } = props
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
  /** 展开中的行：可编辑行展开 = 编辑，只读 / Git 行展开 = 查看。 */
  const [openKey, setOpenKey] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState<SkillRow | undefined>(undefined)
  const [installing, setInstalling] = useState(false)
  /** 列表过滤关键字（名称 / 描述 / 适用场景，大小写不敏感）。 */
  const [filter, setFilter] = useState('')
  /** 「本地已修改」行的更新需确认（将覆盖本地改动）。 */
  const [confirmUpdate, setConfirmUpdate] = useState<SkillRow | undefined>(undefined)

  /** 行的展开标识：作用域 + 根 + 名称在列表内唯一。 */
  const skillKey = (skill: SkillRow): string => `${skill.source}:${skill.rootId ?? ''}:${skill.name}`
  const collapse = (): void => {
    setCreating(false)
    setOpenKey(undefined)
  }

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
            [skill.name, skill.description, skill.whenToUse ?? ''].join('\n').toLowerCase().includes(keyword),
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
    <Panel title={t('panel.title')}>
      <div className={styles.scopeBar}>
        <div className={styles.scopeField}>
          <SelectField
            label={t('scope.label')}
            value={mode}
            options={[
              { value: 'user', label: t('scope.user') },
              { value: 'workspace', label: t('scope.workspace'), disabled: workspaceCwd === undefined },
            ]}
            onChange={(value) => changeMode(value as ScopeMode)}
          />
        </div>
        {mode === 'workspace' && workspaceCwd === undefined ? (
          <span className={styles.scopeHint}>{t('scope.noWorkspaceHint')}</span>
        ) : null}
      </div>

      {state.error ? (
        <div className={styles.error} role="alert">
          {state.error}
        </div>
      ) : null}
      {state.notice !== null ? (
        <Toast key={state.notice} text={state.notice} holdMs={5000} onDone={() => store.dismissNotice()} />
      ) : null}
      <div className={styles.listToolbar}>
        <Button
          variant="primary"
          disabled={state.status !== 'ready'}
          onClick={() => {
            setOpenKey(undefined)
            setCreating(!creating)
          }}
        >
          {t('action.create')}
        </Button>
        <Button variant="outline" disabled={state.status !== 'ready'} onClick={() => setInstalling(true)}>
          {t('action.installGit')}
        </Button>
        <Button
          variant="outline"
          disabled={!hasGitSkills || gitWorking}
          title={hasGitSkills ? undefined : t('action.checkUpdatesDisabled')}
          onClick={() => void store.checkUpdates()}
        >
          {state.gitBusy === 'check' ? t('action.checking') : t('action.checkUpdates')}
        </Button>
        <Button
          variant="outline"
          disabled={state.status === 'loading' || gitWorking}
          onClick={() => void store.refresh()}
        >
          {t('action.refresh')}
        </Button>
      </div>
      {state.status === 'loading' ? <div className={styles.loading}>{t('panel.loading')}</div> : null}

      {state.status === 'ready' ? (
        <div className={styles.searchRow}>
          <Input
            className={fieldInputCls(false)}
            type="text"
            value={filter}
            placeholder={t('search.placeholder')}
            autoComplete="off"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      ) : null}

      {/* 新建卡片放在首行，触发按钮就在上方；长列表不会把表单推离视口。 */}
      <CardList
        items={visible}
        getKey={(skill) => `${skill.source}:${skill.name}:${skill.path ?? ''}`}
        before={
          creating ? (
            <ExpandableCard
              title={t('action.create')}
              open
              onToggle={() => {
                if (!busy) setCreating(false)
              }}
            >
              <SkillForm
                mode="create"
                roots={state.roots}
                skills={state.skills}
                busy={busy}
                error={state.error}
                store={store}
                t={t}
                onDone={collapse}
                onCancel={collapse}
              />
            </ExpandableCard>
          ) : null
        }
        renderCard={(skill) => {
          const key = skillKey(skill)
          const open = openKey === key
          const update =
            skill.rootId !== undefined ? state.updates[updateKey(skill.rootId, skill.name)] : undefined
          const sourceChip = readonlyLabelOf(skill.source, t)
          return {
            title: skill.name,
            pills: [
              ...(sourceChip !== null ? [{ text: sourceChip, title: skill.path }] : []),
              ...(skill.git !== undefined
                ? [
                    {
                      text: <>Git · {repoLabelOf(skill.git.url)}</>,
                      tone: 'brand' as const,
                      title: t('git.pillTitle', {
                        url: skill.git.url,
                        dir: skill.git.dir,
                        date: dateLabelOf(skill.git.installedAt),
                      }),
                    },
                  ]
                : []),
              ...(update?.status === 'update'
                ? [
                    {
                      text: t('update.available'),
                      tone: 'warn' as const,
                      title:
                        update.description !== undefined
                          ? t('update.upstreamDescription', { description: update.description })
                          : t('update.upstreamNew'),
                    },
                  ]
                : []),
              ...(update?.status === 'local'
                ? [
                    {
                      text: t('update.availableLocal'),
                      tone: 'warn' as const,
                      title: t('update.availableLocalTitle'),
                    },
                  ]
                : []),
              ...(update?.status === 'removed'
                ? [{ text: t('update.removed'), title: t('update.removedTitle') }]
                : []),
              ...(skill.invalid !== undefined
                ? [
                    {
                      text: t('pill.invalid', { reason: skill.invalid }),
                      tone: 'err' as const,
                      title: skill.invalid,
                    },
                  ]
                : []),
              ...(skill.effective ? [] : [{ text: t('pill.shadowed') }]),
              ...(skill.userInvocable ? [] : [{ text: t('pill.userInvocableFalse') }]),
            ],
            description: skill.description.length > 0 ? skill.description : t('pill.noDescription'),
            note: skill.whenToUse !== undefined ? t('pill.whenToUse', { text: skill.whenToUse }) : undefined,
            path: skill.path,
            open,
            onToggle: () => {
              if (busy) return
              setCreating(false)
              setOpenKey(open ? undefined : key)
            },
            actions: (
              <>
                {(update?.status === 'update' || update?.status === 'local') && skill.editable ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || state.gitBusy === 'update'}
                    onClick={() => requestUpdate(skill)}
                  >
                    {t('action.update')}
                  </Button>
                ) : null}
                {skill.editable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.dangerGhost}
                    disabled={busy}
                    onClick={() => setDeleting(skill)}
                  >
                    {t('delete')}
                  </Button>
                ) : null}
              </>
            ),
            children: open ? (
              skill.editable ? (
                <SkillForm
                  mode="edit"
                  skill={skill}
                  roots={state.roots}
                  skills={state.skills}
                  busy={busy || state.busy === skill.name}
                  error={state.error}
                  store={store}
                  t={t}
                  onDone={collapse}
                  onCancel={collapse}
                />
              ) : (
                <SkillView skill={skill} busy={busy} error={state.error} store={store} t={t} />
              )
            ) : null,
          }
        }}
        empty={
          state.status === 'ready' && !creating ? (
            <div className={styles.empty}>
              {keyword.length > 0 ? (
                t('empty.filtered', { keyword: filter.trim() })
              ) : (
                <>
                  {interpolateNodes(t('empty.none'), {
                    dsh: <code className={styles.code}>.dsh/skills/</code>,
                    agents: <code className={styles.code}>.agents/skills/</code>,
                    userDsh: <code className={styles.code}>~/.dsh/skills/</code>,
                    userAgents: <code className={styles.code}>~/.agents/skills/</code>,
                  })}
                </>
              )}
            </div>
          ) : null
        }
      />

      {installing ? (
        <GitInstallDialog
          store={store}
          roots={state.roots}
          busy={state.gitBusy !== null}
          scanning={state.gitBusy === 'scan'}
          installing={state.gitBusy === 'install'}
          error={state.error}
          t={t}
          onClose={() => setInstalling(false)}
        />
      ) : null}

      {deleting !== undefined ? (
        <ConfirmDialog
          title={t('confirm.deleteTitle', { name: deleting.name })}
          body={
            deleting.path !== undefined && deleting.path.replaceAll('\\', '/').endsWith('/SKILL.md')
              ? t('confirm.deleteDirBody', { path: deleting.path })
              : t('confirm.deleteFileBody', { path: deleting.path ?? '' })
          }
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
          busy={busy}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const target = deleting
            setDeleting(undefined)
            if (openKey === skillKey(target)) setOpenKey(undefined)
            void store.remove(target)
          }}
        />
      ) : null}

      {confirmUpdate !== undefined ? (
        <ConfirmDialog
          title={t('confirm.updateTitle', { name: confirmUpdate.name })}
          body={t('confirm.updateBody', { url: confirmUpdate.git?.url ?? '' })}
          confirmLabel={t('confirm.updateConfirm')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
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
    </Panel>
  )
}
