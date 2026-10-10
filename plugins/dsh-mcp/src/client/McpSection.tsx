import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CardList,
  ConfirmDialog,
  ExpandableCard,
  Panel,
  SearchBox,
  selectCls,
  useWideSettingsDialog,
} from '@dsh-plugins/client-ui'
import type { McpRow, McpScope } from '../shared'
import { endpointOf, transportOf } from '../mcpConfig'
import { messageText, type McpT, type NS } from './locales'
import type { McpStore } from './store'
import { McpServerForm, McpServerView, ToolsDialog } from './McpServerForm'
import shared from '@dsh-plugins/client-ui/styles'
import local from './McpSection.module.css'

const styles = { ...shared, ...local }

/** 注册方注入面（client.tsx 装配，slot inject 回调提供）。 */
export interface McpSectionInjected {
  store: McpStore
}

/** 完整组件 props：运行时份额 + locale 标准 seat + 注入面。 */
export type McpSectionProps = PropsRuntime<'settings.section'> &
  PropsLocale<typeof NS> &
  InjectFace<McpSectionInjected>

const MODE_KEY = 'dsh-mcp/scope-mode'

type ScopeMode = McpScope

export function McpSection(props: McpSectionProps) {
  useWideSettingsDialog()
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    if (state.status === 'idle') void store.refresh()
  }, [store, state.status])
  useEffect(() => () => store.dismissNotice(), [store])

  // 档位记忆在本地存储：下次打开沿用上次的查看范围。
  const [mode, setMode] = useState<ScopeMode>(() => {
    try {
      return window.localStorage.getItem(MODE_KEY) === 'workspace' ? 'workspace' : 'global'
    } catch {
      return 'global'
    }
  })
  const changeMode = (next: ScopeMode): void => {
    setMode(next)
    setFilter('')
    setCreating(false)
    setEditingKey(undefined)
    try {
      window.localStorage.setItem(MODE_KEY, next)
    } catch {
      // 本地存储不可用时档位仅本次会话生效。
    }
  }

  const [creating, setCreating] = useState(false)
  /** 展开中的行（编辑 / 查看）；undefined = 全部收起。 */
  const [editingKey, setEditingKey] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState<McpRow | undefined>(undefined)
  /** 工具清单弹窗的目标行；undefined = 关闭。 */
  const [toolsRow, setToolsRow] = useState<McpRow | undefined>(undefined)
  /** 列表过滤关键字（名称 / 端点 / 错误摘要，大小写不敏感）。 */
  const [filter, setFilter] = useState('')

  // 工作区名 = 主视图工作目录的末段（选项里展示，帮助区分多个工作区）。
  const workspaceName =
    state.workspaceCwd === undefined ? undefined : state.workspaceCwd.split(/[\\/]/).filter(Boolean).pop()

  const servers = state.list?.servers ?? []
  const busy = state.busy !== null
  const rowKeyOf = (row: McpRow): string => `${row.scope}:${row.name}`
  const scopeRows = useMemo(() => servers.filter((row) => row.scope === mode), [servers, mode])
  const editing = editingKey !== undefined ? scopeRows.find((row) => rowKeyOf(row) === editingKey) : undefined
  const errorText = state.error === null ? null : messageText(state.error, t)
  const noticeText = state.notice === null ? null : messageText(state.notice, t)

  const collapse = (): void => {
    setCreating(false)
    setEditingKey(undefined)
  }

  const keyword = filter.trim().toLowerCase()
  const visible = useMemo(
    () =>
      keyword.length === 0
        ? scopeRows
        : scopeRows.filter((row) =>
            [row.name, endpointOf(row.config), row.live?.error ?? '']
              .join('\n')
              .toLowerCase()
              .includes(keyword),
          ),
    [scopeRows, keyword],
  )

  const renderCard = (row: McpRow) => {
    const key = rowKeyOf(row)
    const expanded = editingKey === key
    const badge = statusBadge(row, t)
    const transport = transportOf(row.config)
    const toolCount = row.live?.tools.length ?? 0
    return {
      title: row.name,
      pills: [
        ...(transport !== undefined ? [{ text: transport === 'stdio' ? 'stdio' : 'HTTP' }] : []),
        {
          text: badge.text,
          tone:
            badge.kind === 'on'
              ? ('ok' as const)
              : badge.kind === 'err'
                ? ('err' as const)
                : ('neutral' as const),
          title: badge.title,
          // 状态徽标带工具数（运行中 · N 工具）时本身即入口：点击打开清单弹窗。
          ...(toolCount > 0
            ? {
                onClick: () => setToolsRow(row),
                title: [badge.title, t('row.toolsHint')].filter(Boolean).join(' · '),
              }
            : {}),
        },
        ...(row.shadowed ? [{ text: t('row.shadowed'), title: t('row.shadowedHint') }] : []),
        ...(row.invalid !== undefined
          ? [{ text: t('row.invalid'), tone: 'err' as const, title: row.invalid }]
          : []),
      ],
      description:
        row.invalid !== undefined ? row.invalid : endpointOf(row.config) || t('row.endpointMissing'),
      error: row.live?.error,
      open: expanded,
      onToggle: () => {
        if (busy) return
        setCreating(false)
        setEditingKey(expanded ? undefined : key)
      },
      actions: (
        <>
          {/* 不合法条目无法映射成表单：只能展示原因与删除，修复走手工改文件。 */}
          {row.invalid === undefined ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void store.setEnabled({ scope: row.scope, name: row.name, enabled: row.disabled })
              }
            >
              {row.disabled ? t('action.enable') : t('action.disable')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className={styles.dangerGhost}
            disabled={busy}
            onClick={() => setDeleting(row)}
          >
            {t('delete')}
          </Button>
        </>
      ),
      children: expanded ? (
        row.invalid === undefined &&
        editing !== undefined &&
        editing.scope === row.scope &&
        editing.name === row.name ? (
          <McpServerForm
            mode="edit"
            row={editing}
            store={store}
            t={t}
            busy={busy}
            error={errorText}
            onDone={collapse}
            onCancel={collapse}
          />
        ) : (
          <McpServerView row={row} t={t} />
        )
      ) : null,
    }
  }

  return (
    <Panel title={t('section.label')} subtitle={t('panel.subtitle')}>
      {/* 工具行：档位下拉 + 搜索过滤 + 动作按钮，其下紧接列表。 */}
      <div className={styles.toolbar}>
        {/* 裸 select：可访问名经 aria-label，省掉堆叠标签的高度。 */}
        <select
          className={`${selectCls} ${styles.scopeSelect}`}
          aria-label={t('scope.label')}
          value={mode}
          onChange={(event) => changeMode(event.target.value as ScopeMode)}
        >
          <option value="global">{t('list.global')}</option>
          <option value="workspace" disabled={state.list?.workspacePath == null}>
            {workspaceName === undefined
              ? t('list.workspace')
              : t('list.workspaceNamed', { name: workspaceName })}
          </option>
        </select>
        {state.status === 'ready' ? (
          <SearchBox
            className={styles.search}
            label={t('search.placeholder')}
            value={filter}
            onChange={setFilter}
          />
        ) : null}
        <div className={styles.toolbarActions}>
          <Button
            variant="primary"
            disabled={state.status !== 'ready'}
            onClick={() => {
              setEditingKey(undefined)
              setCreating(!creating)
            }}
          >
            {t('action.create')}
          </Button>
          <Button
            variant="outline"
            disabled={state.status === 'loading'}
            onClick={() => void store.refresh()}
          >
            {t('action.refresh')}
          </Button>
        </div>
      </div>
      {/* 工作区档选着了却定位不到（本地记忆的档位、cwd 还没上报）时给原因。 */}
      {mode === 'workspace' && state.list?.workspacePath == null ? (
        <span className={styles.scopeHint}>{t('scope.noWorkspaceHint')}</span>
      ) : null}

      {errorText ? (
        <div className={styles.error} role="alert">
          {errorText}
        </div>
      ) : null}
      {noticeText !== null ? (
        <Toast key={noticeText} text={noticeText} holdMs={5000} onDone={() => store.dismissNotice()} />
      ) : null}
      {state.list?.warnings.map((warning) => (
        <div key={warning} className={styles.warnLine}>
          {warning}
        </div>
      ))}
      {state.status === 'loading' ? <div className={styles.loading}>{t('list.loading')}</div> : null}

      {/* 新建卡片放在首行，触发按钮就在上方；长列表不会把表单推离视口。 */}
      <CardList
        items={visible}
        getKey={rowKeyOf}
        before={
          creating ? (
            <ExpandableCard
              title={t('action.create')}
              open
              onToggle={() => {
                if (!busy) setCreating(false)
              }}
            >
              <McpServerForm
                mode="create"
                defaultScope={mode}
                store={store}
                t={t}
                busy={busy}
                error={errorText}
                onDone={collapse}
                onCancel={collapse}
              />
            </ExpandableCard>
          ) : null
        }
        empty={
          state.status === 'ready' ? (
            <div className={styles.empty}>
              {keyword.length > 0
                ? t('list.emptyFiltered', { keyword: filter.trim() })
                : t('list.emptyScope')}
            </div>
          ) : null
        }
        renderCard={renderCard}
      />

      {deleting !== undefined ? (
        <ConfirmDialog
          title={t('delete.title', { name: deleting.name })}
          body={t('delete.body', {
            file:
              deleting.scope === 'global'
                ? (state.list?.globalPath ?? '')
                : (state.list?.workspacePath ?? ''),
          })}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
          busy={busy}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const target = deleting
            setDeleting(undefined)
            if (editingKey === rowKeyOf(target)) setEditingKey(undefined)
            void store.remove({ scope: target.scope, name: target.name }, target.name)
          }}
        />
      ) : null}
      {toolsRow !== undefined ? (
        <ToolsDialog row={toolsRow} t={t} onClose={() => setToolsRow(undefined)} />
      ) : null}
    </Panel>
  )
}

function statusBadge(
  row: McpRow,
  t: McpT,
): { text: string; kind: 'on' | 'off' | 'err' | 'warn'; title?: string } {
  if (row.invalid !== undefined) return { text: t('row.absent'), kind: 'off' }
  if (row.disabled) return { text: t('row.disabled'), kind: 'off' }
  if (row.shadowed) return { text: t('row.shadowed'), kind: 'off' }
  if (row.live === null) return { text: t('row.absent'), kind: 'off' }
  switch (row.live.status) {
    case 'active':
      return { text: t('row.activeTools', { count: row.live.tools.length }), kind: 'on' }
    case 'loading':
    case 'pending':
      return { text: t('row.connecting'), kind: 'warn' }
    case 'failed':
      return { text: t('row.connectFailed'), kind: 'err', title: row.live.error }
    case 'disposed':
    case 'unloading':
      return { text: t('row.unloaded'), kind: 'off' }
    case 'absent':
      return { text: t('row.absent'), kind: 'off' }
  }
}
