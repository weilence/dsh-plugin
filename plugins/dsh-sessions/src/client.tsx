import { useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { errMsg } from '@dsh-plugins/shared'
import { ConfirmDialog } from '@dsh-plugins/client-ui'
import sharedStyles from '@dsh-plugins/client-ui/styles'
import { deleteArchivedSession, importFiles, type FileResult } from './client/api'
import { NS, en, zh, messageText, type Message } from './client/locales'
import localStyles from './client.module.css'

const styles = { ...sharedStyles, ...localStyles }

export const inject = ['slots', 'locale', 'sessions', 'workspaces']
type SessionsSectionProps = PropsRuntime<'settings.section'> &
  PropsLocale<typeof NS> &
  InjectFace<{ sessions: ISessions; workspaces: IWorkspaces; formatTime: (timestamp: number) => string }>
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
  workspaces,
  formatTime,
}: SessionsSectionProps) {
  const snapshot = useWorkspaces((value) => value)
  const list = useSessions((value) => value)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [restoring, setRestoring] = useState<SessionId | null>(null)
  const [deleting, setDeleting] = useState<SessionId | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ id: SessionId; title: string } | null>(null)
  const [failure, setFailure] = useState<{ sessionId: SessionId; message: Message } | null>(null)
  const [notice, setNotice] = useState<Message | null>(null)
  const working = useRef(false)
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

  const restore = async (id: SessionId, title: string) => {
    if (working.current) return
    setFailure(null)
    setNotice(null)
    const current = workspaces.list.getSnapshot()
    if (current.phase !== 'ready' || current.state !== 'idle') {
      setFailure({
        sessionId: id,
        message:
          current.error === null
            ? { key: 'archive.unavailable' }
            : { text: `${current.error.code}: ${current.error.message}` },
      })
      return
    }
    if (!current.archivedSessionIds.includes(id)) {
      setNotice({ key: 'archive.alreadyRestored', params: { title } })
      return
    }
    // 官方归档命令共用请求序号；串行恢复避免不同条目的响应互相覆盖。
    working.current = true
    setRestoring(id)
    try {
      await workspaces.unarchiveSession(id)
      setNotice({ key: 'archive.restored', params: { title } })
    } catch (error) {
      setFailure({ sessionId: id, message: { text: errMsg(error) } })
    } finally {
      working.current = false
      setRestoring(null)
    }
  }

  // 删除与恢复共用互斥：宿主侧两者都要占用存储操作锁，客户端先挡掉并发点击。
  const remove = async (id: SessionId, title: string) => {
    if (working.current) return
    setPendingDelete(null)
    setFailure(null)
    setNotice(null)
    const current = workspaces.list.getSnapshot()
    if (current.phase !== 'ready' || current.state !== 'idle') {
      setFailure({
        sessionId: id,
        message:
          current.error === null
            ? { key: 'archive.unavailable' }
            : { text: `${current.error.code}: ${current.error.message}` },
      })
      return
    }
    if (!current.archivedSessionIds.includes(id)) {
      setNotice({ key: 'archive.alreadyRestored', params: { title } })
      return
    }
    working.current = true
    setDeleting(id)
    try {
      const result = await deleteArchivedSession(id)
      if (result.archiveClearError !== undefined) {
        setFailure({
          sessionId: id,
          message: { key: 'archive.archiveClearFailed', params: { detail: result.archiveClearError } },
        })
        return
      }
      // 宿主没有删除契约，也不广播会话移除；归档条目清除后侧栏立即解除隐藏，
      // 官方会话列表里的过期摘要会让会话看似复活到重启为止，必须主动全量刷新。
      try {
        await sessions.refresh()
      } catch (error) {
        setFailure({
          sessionId: id,
          message: { key: 'archive.refreshFailed', params: { detail: errMsg(error) } },
        })
      }
      setNotice(
        result.filesRemoved
          ? { key: 'archive.deleted', params: { title } }
          : { key: 'archive.deletedNoFiles', params: { title } },
      )
    } catch (error) {
      setFailure({ sessionId: id, message: { text: errMsg(error) } })
    } finally {
      working.current = false
      setDeleting(null)
    }
  }

  return (
    <div className={styles.section}>
      <section className={styles.importSection}>
        <Button variant="primary" onClick={() => setOpen(true)}>
          {t('import')}
        </Button>
      </section>
      <section className={styles.archiveSection}>
        <h2>{t('archive.title')}</h2>
        <p className={styles.description}>{t('archive.description')}</p>
        <input
          type="search"
          aria-label={t('archive.search')}
          placeholder={t('archive.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
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
                      {t(
                        list.phase === 'pending' ? 'archive.metadataLoading' : 'archive.metadataUnavailable',
                      )}
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
                      onClick={() => void restore(id, summary?.displayTitle ?? id)}
                    >
                      {t(restoring === id ? 'archive.restoring' : 'archive.restore')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={styles.dangerGhost}
                      disabled={!ready || restoring !== null || deleting !== null}
                      onClick={() => setPendingDelete({ id, title: summary?.displayTitle ?? id })}
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
          <p role="status" className={styles.detail}>
            {messageText(notice, t)}
          </p>
        ) : null}
      </section>
      {pendingDelete !== null ? (
        <ConfirmDialog
          title={t('archive.deleteConfirmTitle')}
          body={t('archive.deleteConfirm', { title: pendingDelete.title })}
          confirmLabel={t('archive.delete')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
          busy={deleting !== null}
          onCancel={() => {
            if (deleting === null) setPendingDelete(null)
          }}
          onConfirm={() => void remove(pendingDelete.id, pendingDelete.title)}
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
    </div>
  )
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sessions: locale')
  // 两个 half 的同名 sessions 在联合类型检查中相遇；浏览器入口只持有官方 ISessions。
  const sessions = ctx.sessions as unknown as ISessions
  const t = ctx.locale.bind(NS)
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
          workspaces: ctx.workspaces,
          formatTime: (timestamp: number) =>
            new Date(timestamp).toLocaleString(ctx.locale.getSnapshot().active),
        }),
      },
      SessionsSection,
    ),
  )
}
