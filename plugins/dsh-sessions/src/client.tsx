import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { errMsg } from '@dsh-plugins/shared'
import { ConfirmDialog, Panel, SearchBox } from '@dsh-plugins/client-ui'
import sharedStyles from '@dsh-plugins/client-ui/styles'
import { importFiles, type FileResult } from './client/api'
import {
  createMigrateBridge,
  MigrateDialogEntry,
  MigrateMenuItem,
  type MigrateDialogInjected,
  type MigrateMenuItemInjected,
  workspaceSnapshotHook,
} from './client/migrate'
import { NS, en, zh, messageText, type Message } from './client/locales'
import { SessionsStore } from './client/store'
import localStyles from './client.module.css'

const styles = { ...sharedStyles, ...localStyles }

export const inject = ['slots', 'locale', 'sessions', 'workspaces']
type SessionsSectionProps = PropsRuntime<'settings.section'> &
  PropsLocale<typeof NS> &
  InjectFace<{ sessions: ISessions; store: SessionsStore; formatTime: (timestamp: number) => string }>
type ImportDialogProps = Pick<SessionsSectionProps, 't' | 'useWorkspaces'> & {
  onImported: () => Promise<void>
  onClose: () => void
}

export function ImportDialog({ t, useWorkspaces, onImported, onClose }: ImportDialogProps) {
  const snapshot = useWorkspaces((value) => value)
  const [workspaceId, setWorkspaceId] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [results, setResults] = useState<FileResult[]>([])
  const [message, setMessage] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const target = snapshot.items.find((workspace) => workspace.workspaceId === workspaceId)
  const ready = snapshot.phase === 'ready' && snapshot.state === 'idle'

  const submit = async () => {
    if (working.current || files.length === 0) return
    if (!ready || target === undefined) {
      setMessage({ key: 'workspace.unavailable' })
      return
    }
    working.current = true
    setBusy(true)
    setResults([])
    setMessage(null)
    try {
      await importFiles(files, target.path, (result) => setResults((previous) => [...previous, result]))
      setFiles([])
      if (input.current !== null) input.current.value = ''
      try {
        await onImported()
      } catch (error) {
        setMessage({ key: 'result.refreshFailed', params: { detail: errMsg(error) } })
      }
    } catch (error) {
      setMessage({ text: errMsg(error) })
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
            {message !== null ? <p role="alert">{messageText(message, t)}</p> : null}
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
              setMessage(null)
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
              setMessage(null)
            }}
          />
        </label>
        <p className={styles.warning}>{t('warning')}</p>
      </div>
    </Modal>
  )
}

export function SessionsSection({
  t,
  useWorkspaces,
  useSessions,
  sessions,
  store,
  formatTime,
}: SessionsSectionProps) {
  const snapshot = useWorkspaces((value) => value)
  const list = useSessions((value) => value)
  const { restoring, deleting, pendingDelete, failure, notice } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // 面板卸载即清空一次性反馈；store 跨挂载存活，不清会在下次打开时重放旧提示。
  useEffect(() => () => store.dismissFeedback(), [store])
  const ready = snapshot.phase === 'ready' && snapshot.state === 'idle'
  const keyword = query.trim().toLocaleLowerCase()
  const listed = new Set(list.ids)
  const workspaceBySession = new Map(
    snapshot.items.flatMap((workspace) => workspace.sessionIds.map((id) => [id, workspace] as const)),
  )
  const rows = snapshot.archivedSessionIds
    .map((id) => {
      const summary = listed.has(id) ? list.byId[id] : undefined
      const workspace = workspaceBySession.get(id)
      return { id, summary, workspace }
    })
    .filter(({ id, summary, workspace }) =>
      [id, summary?.displayTitle, summary?.cwd, workspace?.title, workspace?.path].some((value) =>
        value?.toLocaleLowerCase().includes(keyword),
      ),
    )
    .reverse()

  return (
    <Panel title={t('section.label')} subtitle={t('panel.subtitle')}>
      <div className={styles.toolbar}>
        <Button variant="primary" onClick={() => setOpen(true)}>
          {t('import')}
        </Button>
        <SearchBox className={styles.search} label={t('archive.search')} value={query} onChange={setQuery} />
      </div>
      {snapshot.error !== null ? (
        <p role="alert" className={styles.detail}>
          {snapshot.error.code}: {snapshot.error.message}
        </p>
      ) : !ready ? (
        <p role="status">{t('archive.loading')}</p>
      ) : snapshot.archivedSessionIds.length === 0 ? (
        <p>{t('archive.empty')}</p>
      ) : rows.length === 0 ? (
        <p>{t('archive.noMatch')}</p>
      ) : null}
      {snapshot.phase === 'ready' ? (
        <ul className={styles.archives}>
          {rows.map(({ id, summary, workspace }) => (
            <li key={id} className={styles.archiveRow}>
              <div className={styles.metadata}>
                <strong>{summary?.displayTitle ?? id}</strong>
                <code>{id}</code>
                {workspace !== undefined ? (
                  <span>
                    {workspace.title} — {workspace.path}
                  </span>
                ) : (
                  <span>{t('archive.ungrouped')}</span>
                )}
                {summary?.cwd !== undefined && summary.cwd !== workspace?.path ? (
                  <code>{summary.cwd}</code>
                ) : null}
                {summary === undefined ? (
                  <span>
                    {t(list.phase === 'pending' ? 'archive.metadataLoading' : 'archive.metadataUnavailable')}
                  </span>
                ) : Number.isFinite(summary.updatedAt) &&
                  !Number.isNaN(new Date(summary.updatedAt).getTime()) ? (
                  <time dateTime={new Date(summary.updatedAt).toISOString()}>
                    {t('archive.updated', { time: formatTime(summary.updatedAt) })}
                  </time>
                ) : null}
              </div>
              <div className={styles.restoreAction}>
                {failure?.sessionId === id ? <p role="alert">{messageText(failure.message, t)}</p> : null}
                <div className={styles.rowActions}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!ready || restoring !== null || deleting !== null}
                    onClick={() => void store.restore(id, summary?.displayTitle ?? id)}
                  >
                    {t(restoring === id ? 'archive.restoring' : 'archive.restore')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={styles.dangerGhost}
                    disabled={!ready || restoring !== null || deleting !== null}
                    onClick={() => store.askDelete({ id, title: summary?.displayTitle ?? id })}
                  >
                    {t(deleting === id ? 'archive.deleting' : 'archive.delete')}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {failure !== null &&
      (snapshot.phase !== 'ready' || !rows.some((row) => row.id === failure.sessionId)) ? (
        <p role="alert" className={styles.detail}>
          {messageText(failure.message, t)}
        </p>
      ) : null}
      {restoring !== null && (snapshot.phase !== 'ready' || !rows.some((row) => row.id === restoring)) ? (
        <p role="status">{t('archive.restoring')}</p>
      ) : null}
      {deleting !== null && (snapshot.phase !== 'ready' || !rows.some((row) => row.id === deleting)) ? (
        <p role="status">{t('archive.deleting')}</p>
      ) : null}
      {notice !== null ? (
        // 一次性提示走官方 Toast：淡出后清空，下次操作即替换；文本相同也换 key 重开计时。
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
          body={t('archive.deleteConfirm', { title: pendingDelete.title })}
          confirmLabel={t('archive.delete')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
          busy={deleting !== null}
          onCancel={() => store.askDelete(null)}
          onConfirm={() => void store.remove(pendingDelete.id, pendingDelete.title)}
        />
      ) : null}
      {open ? (
        <ImportDialog
          t={t}
          useWorkspaces={useWorkspaces}
          onImported={() => sessions.refresh()}
          onClose={() => setOpen(false)}
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
          formatTime: (timestamp: number) =>
            new Date(timestamp).toLocaleString(ctx.locale.getSnapshot().active),
        }),
      },
      SessionsSection,
    ),
  )
  // 会话行菜单与常驻弹窗经同一桥传递迁移请求；行随菜单关闭卸载，弹窗必须挂在行外。
  const bridge = createMigrateBridge()
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
