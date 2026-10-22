import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ISessions, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import {
  CardList,
  ConfirmDialog,
  MetaItem,
  Panel,
  SearchBox,
  useWideSettingsDialog,
} from '@dsh-plugins/client-ui'
import sharedStyles from '@dsh-plugins/client-ui/styles'
import { importFiles, type FileResult } from './client/api'
import {
  BatchDeletePreview,
  BatchMigrateDialog,
  BatchPresetDialog,
  BatchResultDialog,
  BatchToolbar,
  type BatchTargetView,
} from './client/batch'
import {
  createMigrateBridge,
  MigrateDialogEntry,
  MigrateMenuItem,
  type MigrateBridge,
  type MigrateDialogInjected,
  type MigrateMenuItemInjected,
  workspaceSnapshotHook,
} from './client/migrate'
import { PresetDialog, type PresetTarget } from './client/preset'
import { NS, en, zh, messageText, type Message } from './client/locales'
import { SessionsStore } from './client/store'
import localStyles from './client.module.css'

const styles = { ...sharedStyles, ...localStyles }

export const inject = ['slots', 'locale', 'sessions', 'workspaces']
type SessionsSectionProps = PropsRuntime<'settings.section'> &
  PropsLocale<typeof NS> &
  InjectFace<{
    sessions: ISessions
    store: SessionsStore
    bridge: MigrateBridge
    formatTime: (timestamp: number) => string
  }>
type ImportDialogProps = Pick<SessionsSectionProps, 't' | 'useWorkspaces'> & {
  onImported: () => Promise<void>
  onClose: () => void
}

export function ImportDialog({ t, useWorkspaces, onImported, onClose }: ImportDialogProps) {
  const snapshot = useWorkspaces((value) => value)
  const [workspaceId, setWorkspaceId] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [results, setResults] = useState<FileResult[]>([])
  const [notice, setNotice] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const target = snapshot.items.find((workspace) => workspace.workspaceId === workspaceId)
  const ready = snapshot.phase === 'ready' && snapshot.state === 'idle'

  const submit = async () => {
    if (working.current || files.length === 0) return
    if (!ready || target === undefined) {
      setNotice({ key: 'workspace.unavailable' })
      return
    }
    working.current = true
    setBusy(true)
    setResults([])
    setNotice(null)
    try {
      await importFiles(files, target.path, (result) => setResults((previous) => [...previous, result]))
      setFiles([])
      if (input.current !== null) input.current.value = ''
      try {
        await onImported()
      } catch (error) {
        setNotice({ key: 'result.refreshFailed', params: { detail: errMsg(error) } })
      }
    } catch (error) {
      setNotice({ text: errMsg(error) })
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={t('import')}
      closeLabel={t('close')}
      onClose={() => {
        if (!working.current) onClose()
      }}
      className={styles.dialog}
      footer={
        <div className={styles.footer}>
          <div className={styles.feedback} aria-live="polite">
            {results.map((entry, index) => (
              <div key={index}>
                <strong>{entry.filename}</strong>
                <p>
                  {'error' in entry
                    ? messageText(entry.error, t)
                    : entry.result.failure === undefined
                      ? t('result.done', {
                          imported: entry.result.imported.length,
                          skipped: entry.result.skipped.length,
                        })
                      : t('result.failed', {
                          detail: entry.result.failure.reason,
                          imported: entry.result.imported.length,
                          skipped: entry.result.skipped.length,
                          incomplete: entry.result.incomplete.join(', ') || '—',
                        })}
                </p>
              </div>
            ))}
            {notice !== null ? (
              // 提示信息统一走 notice：5 秒横幅，淡出后清空，下次操作即替换。
              <Toast
                key={messageText(notice, t)}
                text={messageText(notice, t)}
                holdMs={5000}
                onDone={() => setNotice(null)}
              />
            ) : null}
            {!busy && workspaceId !== '' && target === undefined ? (
              <p role="alert">{t('workspace.unavailable')}</p>
            ) : null}
            {busy ? <p role="status">{t('working')}</p> : null}
          </div>
          <div className={styles.actions}>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t('close')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !ready || target === undefined || files.length === 0}
              onClick={() => void submit()}
            >
              {t('import')}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.fields}>
        <label>
          {t('workspace')}
          <select
            data-modal-autofocus
            value={workspaceId}
            disabled={busy || !ready}
            onChange={(event) => {
              setWorkspaceId(event.target.value)
              setNotice(null)
            }}
          >
            <option value="">{t('workspace.choose')}</option>
            {snapshot.items.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.title} — {workspace.path}
              </option>
            ))}
          </select>
        </label>
        {snapshot.error !== null ? (
          <p role="alert">
            {snapshot.error.code}: {snapshot.error.message}
          </p>
        ) : snapshot.phase === 'pending' || snapshot.state === 'loading' ? (
          <p role="status">{t('workspace.loading')}</p>
        ) : snapshot.items.length === 0 ? (
          <p>{t('workspace.empty')}</p>
        ) : null}
        {target !== undefined ? <code className={styles.path}>{target.path}</code> : null}
        <label>
          {t('files')}
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            multiple
            disabled={busy}
            onChange={(event) => {
              setFiles(Array.from(event.target.files ?? []))
              setResults([])
              setNotice(null)
            }}
          />
        </label>
        <p className={styles.warning}>{t('warning')}</p>
      </div>
    </Modal>
  )
}

type WorkspaceFilter = '' | 'ungrouped' | string
type StatusFilter = 'all' | 'active' | 'archived'
type SortKey = 'updated-desc' | 'updated-asc' | 'title-asc' | 'title-desc'

interface SessionRow {
  id: SessionId
  summary: SessionSummary | undefined
  workspaceId: string | undefined
  workspaceTitle: string | undefined
  workspacePath: string | undefined
  archived: boolean
}

function buildRows(
  snapshot: WorkspaceSnapshot,
  list: { ids: readonly SessionId[]; byId: Record<string, SessionSummary> },
  keyword: string,
): SessionRow[] {
  const workspaceBySession = new Map(
    snapshot.items.flatMap((workspace) => workspace.sessionIds.map((id) => [id, workspace] as const)),
  )
  const archived = new Set(snapshot.archivedSessionIds)
  // 官方快照的成员面：宿主列表 id、归档集，以及仅作为 subagent 回退行存在于 byId 的子会话。
  const ids = [
    ...list.ids,
    ...snapshot.archivedSessionIds,
    ...Object.values(list.byId)
      .filter((summary) => summary.origin === 'subagent')
      .map((summary) => summary.id),
  ]
  const rows = [...new Set(ids)].map((id) => {
    const workspace = workspaceBySession.get(id)
    return {
      id,
      summary: list.byId[id],
      workspaceId: workspace?.workspaceId,
      workspaceTitle: workspace?.title,
      workspacePath: workspace?.path,
      archived: archived.has(id),
    }
  })
  if (keyword === '') return rows
  return rows.filter(({ id, summary, workspaceTitle, workspacePath }) =>
    [id, summary?.displayTitle, summary?.cwd, workspaceTitle, workspacePath].some((value) =>
      value?.toLocaleLowerCase().includes(keyword),
    ),
  )
}

export function SessionsSection({
  t,
  useWorkspaces,
  useSessions,
  sessions,
  store,
  bridge,
  formatTime,
}: SessionsSectionProps) {
  // 与 dsh-skills 同款：本分区激活期间加宽宿主设置弹窗，切走即还原。
  useWideSettingsDialog()
  const snapshot = useWorkspaces((value) => value)
  const list = useSessions((value) => value)
  const { working, pendingDelete, notice, batch } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  const [openImport, setOpenImport] = useState(false)
  const [presetTarget, setPresetTarget] = useState<PresetTarget | null>(null)
  const [batchDialog, setBatchDialog] = useState<'migrate' | 'preset' | 'delete' | null>(null)
  const [query, setQuery] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState<WorkspaceFilter>('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('updated-desc')
  const [showSubagents, setShowSubagents] = useState(false)
  const [runningOnly, setRunningOnly] = useState(false)
  const [showBlank, setShowBlank] = useState(false)
  /** 展开中的卡片行：一次只展开一张（与 dsh-skills 列表同款交互）。 */
  const [openId, setOpenId] = useState<SessionId | undefined>(undefined)
  // 面板卸载即清空一次性反馈；store 跨挂载存活，不清会在下次打开时重放旧提示。
  useEffect(() => () => store.dismissFeedback(), [store])
  const ready = snapshot.phase === 'ready' && snapshot.state === 'idle'
  const keyword = query.trim().toLocaleLowerCase()

  const rows = useMemo(() => {
    const all = buildRows(snapshot, list, keyword)
    const filtered = all.filter((row) => {
      if (!showSubagents && row.summary?.origin === 'subagent') return false
      if (runningOnly && row.summary?.running !== true) return false
      if (!showBlank && row.summary?.blank === true) return false
      if (workspaceFilter === 'ungrouped' && row.workspaceId !== undefined) return false
      if (workspaceFilter !== '' && workspaceFilter !== 'ungrouped' && row.workspaceId !== workspaceFilter)
        return false
      if (statusFilter === 'active' && row.archived) return false
      if (statusFilter === 'archived' && !row.archived) return false
      return true
    })
    const titleOf = (row: SessionRow): string => row.summary?.displayTitle ?? row.id
    return filtered.sort((left, right) => {
      switch (sortKey) {
        case 'updated-asc':
          return (left.summary?.updatedAt ?? 0) - (right.summary?.updatedAt ?? 0)
        case 'title-asc':
          return titleOf(left).localeCompare(titleOf(right))
        case 'title-desc':
          return titleOf(right).localeCompare(titleOf(left))
        default:
          return (right.summary?.updatedAt ?? 0) - (left.summary?.updatedAt ?? 0)
      }
    })
  }, [snapshot, list, keyword, showSubagents, runningOnly, showBlank, workspaceFilter, statusFilter, sortKey])

  const childCount = useMemo(
    () =>
      pendingDelete === null
        ? 0
        : Object.values(list.byId).filter((summary) => summary.parentId === pendingDelete.id).length,
    [pendingDelete, list.byId],
  )
  const busy = working !== null
  const workingLabels = {
    archive: 'working.archive',
    restore: 'working.restore',
    delete: 'working.delete',
  } as const
  const rowWorking = (id: SessionId): string | undefined =>
    working !== null && working.id === id ? t(workingLabels[working.kind]) : undefined

  // 批量目标：从官方快照补齐选择集的标题与运行态（行可能已被过滤条件隐藏）。
  const batchTargets: BatchTargetView[] = batch.selection.map((id) => ({
    id,
    title: list.byId[id]?.displayTitle ?? id,
    running: list.byId[id]?.running === true,
  }))
  const batchSubmit = (mode: 'archive' | 'unarchive') => {
    void store.runBatchArchive(
      batchTargets.map(({ id, title }) => ({ id, title })),
      mode,
    )
  }

  return (
    <Panel title={t('section.label')} subtitle={t('panel.subtitle')}>
      <div className={styles.toolbar}>
        <Button variant="primary" onClick={() => setOpenImport(true)}>
          {t('import')}
        </Button>
        <SearchBox className={styles.search} label={t('search')} value={query} onChange={setQuery} />
        <Button variant="outline" disabled={batch.running} onClick={() => store.toggleBatchMode()}>
          {t(batch.active ? 'batch.exit' : 'batch.toggle')}
        </Button>
      </div>
      {batch.active ? (
        <BatchToolbar
          t={t}
          count={batch.selection.length}
          running={batch.running}
          disabled={busy || !ready}
          onSelectVisible={() => store.selectVisible(rows.map((row) => row.id))}
          onClearSelection={() => store.clearSelection()}
          onArchive={() => batchSubmit('archive')}
          onUnarchive={() => batchSubmit('unarchive')}
          onMigrate={() => setBatchDialog('migrate')}
          onPreset={() => setBatchDialog('preset')}
          onDelete={() => setBatchDialog('delete')}
        />
      ) : null}
      <div className={styles.filters}>
        <label>
          {t('filter.workspace')}
          <select
            value={workspaceFilter}
            onChange={(event) => setWorkspaceFilter(event.target.value as WorkspaceFilter)}
          >
            <option value="">{t('filter.workspaceAll')}</option>
            <option value="ungrouped">{t('archive.ungrouped')}</option>
            {snapshot.items.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('filter.status')}
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          >
            <option value="all">{t('filter.statusAll')}</option>
            <option value="active">{t('filter.statusActive')}</option>
            <option value="archived">{t('filter.statusArchived')}</option>
          </select>
        </label>
        <label>
          {t('filter.sort')}
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
            <option value="updated-desc">{t('filter.sortUpdatedDesc')}</option>
            <option value="updated-asc">{t('filter.sortUpdatedAsc')}</option>
            <option value="title-asc">{t('filter.sortTitleAsc')}</option>
            <option value="title-desc">{t('filter.sortTitleDesc')}</option>
          </select>
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={showSubagents}
            onChange={(event) => setShowSubagents(event.target.checked)}
          />
          {t('filter.showSubagents')}
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={runningOnly}
            onChange={(event) => setRunningOnly(event.target.checked)}
          />
          {t('filter.runningOnly')}
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={showBlank}
            onChange={(event) => setShowBlank(event.target.checked)}
          />
          {t('filter.showBlank')}
        </label>
      </div>
      {snapshot.error !== null ? (
        <p role="alert" className={styles.detail}>
          {snapshot.error.code}: {snapshot.error.message}
        </p>
      ) : !ready ? (
        <p role="status">{t('archive.loading')}</p>
      ) : null}
      {/* 会话列表：与 dsh-skills 同款可展开卡片（批量模式行首出选择框、隐藏行内动作）。 */}
      <CardList
        items={rows}
        getKey={(row) => row.id}
        empty={
          ready && rows.length === 0 ? (
            <p className={styles.empty}>
              {keyword === '' &&
              workspaceFilter === '' &&
              statusFilter === 'all' &&
              !showSubagents &&
              !runningOnly &&
              !showBlank
                ? t('archive.emptyList')
                : t('archive.noMatch')}
            </p>
          ) : null
        }
        renderCard={(row) => {
          const { id, summary } = row
          const state = rowWorking(id)
          const title = summary?.displayTitle ?? id
          const open = openId === id
          const updatedLabel =
            summary !== undefined &&
            Number.isFinite(summary.updatedAt) &&
            !Number.isNaN(new Date(summary.updatedAt).getTime())
              ? formatTime(summary.updatedAt)
              : undefined
          return {
            selection: batch.active
              ? {
                  checked: batch.selection.includes(id),
                  disabled: batch.running,
                  label: title,
                  onToggle: () => store.toggleSelected(id),
                }
              : undefined,
            title,
            meta: id,
            pills: [
              ...(row.archived ? [{ text: t('badge.archived') }] : []),
              ...(summary?.running ? [{ text: t('badge.running'), tone: 'ok' as const }] : []),
              ...(summary?.origin === 'subagent' ? [{ text: t('badge.subagent') }] : []),
              ...(summary?.blank ? [{ text: t('badge.blank') }] : []),
            ],
            description:
              row.workspaceTitle !== undefined
                ? `${row.workspaceTitle} — ${row.workspacePath}`
                : t('archive.ungrouped'),
            info:
              updatedLabel !== undefined ? [{ label: t('detail.updated'), value: updatedLabel }] : undefined,
            note: summary === undefined ? t('archive.metadataLoading') : undefined,
            path: summary?.cwd !== undefined && summary.cwd !== row.workspacePath ? summary.cwd : undefined,
            open,
            onToggle: () => {
              if (busy) return
              setOpenId(open ? undefined : id)
            },
            actions: batch.active ? (
              state !== undefined ? (
                <p role="status" className={styles.rowStatus}>
                  {state}
                </p>
              ) : undefined
            ) : (
              <>
                {state !== undefined ? (
                  <p role="status" className={styles.rowStatus}>
                    {state}
                  </p>
                ) : null}
                {row.archived ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !ready}
                    onClick={() => void store.restore(id, title)}
                  >
                    {t('archive.restore')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !ready}
                    onClick={() => void store.archive(id, title)}
                  >
                    {t('archive.archive')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !ready || summary?.origin === 'subagent'}
                  onClick={() => bridge.open({ sessionId: id, title })}
                >
                  {t('migrate')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !ready || summary?.origin === 'subagent'}
                  onClick={() => setPresetTarget({ sessionId: id, title })}
                >
                  {t('preset.entry')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={styles.dangerGhost}
                  disabled={busy || !ready || summary?.running === true}
                  onClick={() => store.askDelete({ id, title })}
                >
                  {t('archive.delete')}
                </Button>
              </>
            ),
            children: open ? (
              <div className={styles.detailGrid}>
                <MetaItem label={t('detail.id')} value={id} wide />
                <MetaItem
                  label={t('detail.workspace')}
                  value={
                    row.workspaceTitle !== undefined
                      ? `${row.workspaceTitle} — ${row.workspacePath}`
                      : undefined
                  }
                  wide
                />
                <MetaItem label={t('detail.cwd')} value={summary?.cwd} wide />
                {summary?.origin === 'subagent' ? (
                  <MetaItem label={t('detail.parent')} value={summary.parentId} wide />
                ) : null}
                {updatedLabel !== undefined ? (
                  <MetaItem label={t('detail.updated')} value={updatedLabel} />
                ) : null}
              </div>
            ) : null,
          }
        }}
      />
      {notice !== null ? (
        // 提示信息统一走 notice（官方 Toast 横幅）：成功与失败同流，淡出后清空、下次操作即替换。
        <Toast
          key={messageText(notice, t)}
          text={messageText(notice, t)}
          holdMs={5000}
          onDone={() => store.dismissNotice()}
        />
      ) : null}
      {pendingDelete !== null ? (
        <ConfirmDialog
          title={t('archive.deleteConfirmTitle')}
          body={
            childCount > 0
              ? t('archive.deleteConfirmCascade', { title: pendingDelete.title, count: childCount })
              : t('archive.deleteConfirm', { title: pendingDelete.title })
          }
          confirmLabel={t('archive.delete')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
          busy={busy}
          onCancel={() => store.askDelete(null)}
          onConfirm={() => void store.remove(pendingDelete.id, pendingDelete.title)}
        />
      ) : null}
      {presetTarget !== null ? (
        <PresetDialog t={t} target={presetTarget} onClose={() => setPresetTarget(null)} />
      ) : null}
      {openImport ? (
        <ImportDialog
          t={t}
          useWorkspaces={useWorkspaces}
          onImported={() => sessions.refresh()}
          onClose={() => setOpenImport(false)}
        />
      ) : null}
      {batchDialog === 'migrate' ? (
        <BatchMigrateDialog
          t={t}
          workspaces={snapshot.items.map((workspace) => ({
            workspaceId: workspace.workspaceId,
            title: workspace.title,
            path: workspace.path,
          }))}
          busy={batch.running}
          onConfirm={(workspaceId) => {
            setBatchDialog(null)
            void store.runBatchMigrate(
              batchTargets.map(({ id, title }) => ({ id, title })),
              workspaceId,
            )
          }}
          onClose={() => setBatchDialog(null)}
        />
      ) : null}
      {batchDialog === 'preset' ? (
        <BatchPresetDialog
          t={t}
          busy={batch.running}
          onConfirm={(toPreset) => {
            setBatchDialog(null)
            void store.runBatchPreset(
              batchTargets.map(({ id, title }) => ({ id, title })),
              toPreset,
            )
          }}
          onClose={() => setBatchDialog(null)}
        />
      ) : null}
      {batchDialog === 'delete' ? (
        <BatchDeletePreview
          t={t}
          targets={batchTargets}
          busy={batch.running}
          onConfirm={() => {
            setBatchDialog(null)
            void store.runBatchDelete(batchTargets.map(({ id, title }) => ({ id, title })))
          }}
          onCancel={() => setBatchDialog(null)}
        />
      ) : null}
      {batch.outcome !== null ? (
        <BatchResultDialog
          t={t}
          outcome={batch.outcome}
          busy={batch.running}
          onRetry={() => void store.retryOutcome()}
          onClose={() => store.dismissOutcome()}
        />
      ) : null}
    </Panel>
  )
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sessions: locale')
  // 两个 half 的同名 sessions 在联合类型检查中相遇；浏览器入口只持有官方 ISessions。
  const sessions = ctx.sessions as unknown as ISessions
  const t = ctx.locale.bind(NS)
  // 会话行菜单与常驻弹窗经同一桥传递迁移请求；行随菜单关闭卸载，弹窗必须挂在行外。
  const bridge = createMigrateBridge()
  const store = new SessionsStore(ctx.workspaces, () => sessions.refresh())
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-sessions',
        order: 43,
        label: () => t('section.label'),
        locale: NS,
        inject: () => ({
          sessions,
          store,
          bridge,
          formatTime: (timestamp: number) =>
            new Date(timestamp).toLocaleString(ctx.locale.getSnapshot().active),
        }),
      },
      SessionsSection,
    ),
  )
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.menu.item',
        id: 'dsh-sessions.migrate-session',
        order: 500,
        locale: NS,
        inject: (): MigrateMenuItemInjected => ({
          requestMigrate: (target) => {
            bridge.open(target)
          },
        }),
      },
      MigrateMenuItem,
    ),
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-sessions.migrate-dialog',
        locale: NS,
        inject: (): MigrateDialogInjected => ({
          bridge,
          useWorkspaceList: workspaceSnapshotHook(ctx.workspaces),
          refreshSessions: () => sessions.refresh(),
        }),
      },
      MigrateDialogEntry,
    ),
  )
}
