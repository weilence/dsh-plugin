import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Panel, useWideSettingsDialog } from '@dsh-plugins/client-ui'
import { errMsg } from '@dsh-plugins/shared'
import { createBridgeClient } from '@dsh-plugins/shared/api'
import type { RemoteTransportConnection } from '@dsh-plugins/shared/remote'
import { NS, en, zh, type SessionsKey, type SessionsT } from './client/locales'
import {
  EXPORT_PATH,
  IMPORT_PATH,
  LIST_PATH,
  MAX_ARCHIVE_BYTES,
  PREVIEW_PATH,
  REMOTES_PATH,
  TRANSFER_PATH,
  type ArchivePreview,
  type ExportResponse,
  type ImportResult,
  type SessionListItem,
} from './shared'
import styles from './client.module.css'

export const inject = ['slots', 'locale', 'sessions']
const api = createBridgeClient('x-dsh-sessions')
type Message = { key: SessionsKey; params?: Record<string, string | number> } | { text: string }
type SessionSectionProps = PropsRuntime<'settings.section'> &
  PropsLocale<typeof NS> &
  InjectFace<{ onImported: () => Promise<void> }>

function messageText(message: Message, t: SessionsT): string {
  return 'text' in message ? message.text : t(message.key, message.params)
}

function base64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  }
  return btoa(parts.join(''))
}

function download(result: ExportResponse): void {
  const raw = atob(result.archive)
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.href = url
  link.download = result.filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function Preview({ preview, t }: { preview: ArchivePreview; t: SessionsT }) {
  return (
    <div className={styles.preview}>
      <strong>{t('preview.heading', { count: preview.sessions.length })}</strong>
      <ul>
        {preview.sessions.map((session) => (
          <li key={session.id}>
            <code>{session.id}</code>
            <span>
              {t(`status.${session.status}`)} · {t('events', { count: session.eventCount })}
            </span>
            {session.cwd !== undefined ? <code>{session.cwd}</code> : null}
          </li>
        ))}
      </ul>
      {preview.sessions.some((session) => session.status === 'conflict') ? (
        <p role="alert">{t('preview.conflict')}</p>
      ) : null}
    </div>
  )
}

export function SessionSection({ t, onImported }: SessionSectionProps) {
  useWideSettingsDialog()
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [remotes, setRemotes] = useState<RemoteTransportConnection[]>([])
  const [remoteAvailable, setRemoteAvailable] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [remoteId, setRemoteId] = useState('')
  const [archive, setArchive] = useState<string | null>(null)
  const [localCwd, setLocalCwd] = useState('')
  const [remoteCwd, setRemoteCwd] = useState('')
  const [localPreview, setLocalPreview] = useState<ArchivePreview | null>(null)
  const [remotePreview, setRemotePreview] = useState<ArchivePreview | null>(null)
  const [remoteArchive, setRemoteArchive] = useState<string | null>(null)
  const [localTrust, setLocalTrust] = useState(false)
  const [remoteTrust, setRemoteTrust] = useState(false)
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const [localMessage, setLocalMessage] = useState<Message | null>(null)
  const [remoteMessage, setRemoteMessage] = useState<Message | null>(null)
  const [exportMessage, setExportMessage] = useState<Message | null>(null)

  const load = async () => {
    const results = await Promise.allSettled([
      api.request<{ sessions: SessionListItem[] }>(LIST_PATH),
      api.request<{ available: boolean; connections: RemoteTransportConnection[] }>(REMOTES_PATH),
    ])
    const [local, remote] = results
    if (local.status === 'fulfilled') {
      setSessions(local.value.sessions)
    } else {
      setSessions([])
      setExportMessage({ text: errMsg(local.reason) })
    }
    if (remote.status === 'fulfilled') {
      setRemotes(remote.value.connections)
      setRemoteAvailable(remote.value.available)
      setRemoteError(null)
    } else {
      setRemotes([])
      setRemoteAvailable(false)
      setRemoteError(errMsg(remote.reason))
    }
  }

  const run = async (setMessage: (message: Message | null) => void, operation: () => Promise<void>) => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setMessage(null)
    try {
      await operation()
    } catch (error) {
      setMessage({ text: errMsg(error) })
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  useEffect(() => {
    void run(setExportMessage, load)
  }, [])

  const clearLocalPreview = () => {
    setLocalPreview(null)
    setLocalTrust(false)
    setLocalMessage(null)
  }
  const clearRemotePreview = () => {
    setRemotePreview(null)
    setRemoteArchive(null)
    setRemoteTrust(false)
    setRemoteMessage(null)
  }
  const target = remotes.find((connection) => connection.id === remoteId)
  const localReady =
    localPreview !== null && !localPreview.sessions.some((session) => session.status === 'conflict')
  const remoteReady =
    remotePreview !== null && !remotePreview.sessions.some((session) => session.status === 'conflict')

  const showResult = (result: ImportResult, setMessage: (message: Message) => void) => {
    setMessage(
      result.failure === undefined
        ? { key: 'result.done', params: { imported: result.imported.length, skipped: result.skipped.length } }
        : {
            key: 'result.failed',
            params: {
              detail: result.failure.reason,
              imported: result.imported.length,
              incomplete: result.incomplete.join(', ') || '—',
            },
          },
    )
  }

  const importLocal = async () => {
    if (archive === null || localPreview === null) return
    const expected = localPreview.expected
    const trusted = localTrust
    setLocalPreview(null)
    setLocalTrust(false)
    const result = await api.request<ImportResult>(IMPORT_PATH, {
      method: 'POST',
      body: JSON.stringify({ archive, cwd: localCwd, expected, trusted }),
    })
    showResult(result, setLocalMessage)
    try {
      await onImported()
      await load()
    } catch (error) {
      setLocalMessage({ key: 'result.refreshFailed', params: { detail: errMsg(error) } })
    }
  }

  const previewRemote = async () => {
    clearRemotePreview()
    const exported = await api.request<ExportResponse>(EXPORT_PATH, {
      method: 'POST',
      body: JSON.stringify({ id: source }),
    })
    const preview = await api.request<ArchivePreview>(TRANSFER_PATH, {
      method: 'POST',
      body: JSON.stringify({ remoteId, action: 'preview', archive: exported.archive, cwd: remoteCwd }),
    })
    setRemoteArchive(exported.archive)
    setRemotePreview(preview)
  }

  const importRemote = async () => {
    if (remoteArchive === null || remotePreview === null) return
    const snapshot = remoteArchive
    const expected = remotePreview.expected
    const trusted = remoteTrust
    setRemotePreview(null)
    setRemoteArchive(null)
    setRemoteTrust(false)
    const result = await api.request<ImportResult>(TRANSFER_PATH, {
      method: 'POST',
      body: JSON.stringify({
        remoteId,
        action: 'import',
        archive: snapshot,
        cwd: remoteCwd,
        expected,
        trusted,
      }),
    })
    showResult(result, setRemoteMessage)
  }

  const trustCheckbox = (checked: boolean, onChange: (value: boolean) => void) => (
    <label className={styles.trust}>
      <input
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={(event) => onChange(event.target.checked)}
      />
      {t('trust')}
    </label>
  )

  return (
    <Panel title={t('title')} subtitle={t('subtitle')}>
      <section className={styles.section}>
        <label>
          {t('source')}
          <select
            value={source}
            disabled={busy}
            onChange={(event) => {
              setSource(event.target.value)
              clearRemotePreview()
              setExportMessage(null)
            }}
          >
            <option value="">{t('choose')}</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title ?? session.id}
              </option>
            ))}
          </select>
        </label>
        {source ? (
          <div className={styles.identity}>
            <code>{source}</code>
            <code>{sessions.find((session) => session.id === source)?.cwd}</code>
          </div>
        ) : null}
        {sessions.find((session) => session.id === source)?.titleError !== undefined ? (
          <p role="alert">
            {t('title.failed', { detail: sessions.find((session) => session.id === source)!.titleError! })}
          </p>
        ) : null}
        <p className={styles.hint}>{t('export.warning')}</p>
        {exportMessage !== null ? <p role="status">{messageText(exportMessage, t)}</p> : null}
        <div className={styles.actions}>
          <Button
            disabled={busy || !source}
            onClick={() =>
              void run(setExportMessage, async () => {
                const result = await api.request<ExportResponse>(EXPORT_PATH, {
                  method: 'POST',
                  body: JSON.stringify({ id: source }),
                })
                download(result)
                setExportMessage({ key: 'export.done' })
              })
            }
          >
            {t('export')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(setExportMessage, async () => {
                clearLocalPreview()
                clearRemotePreview()
                await load()
              })
            }
          >
            {t('refresh')}
          </Button>
        </div>
      </section>
      <p className={styles.hint}>{t('warning.environment')}</p>
      <p className={styles.warning}>{t('warning.permissions')}</p>
      <section className={styles.section}>
        <h3>{t('local.title')}</h3>
        <label>
          {t('file')}
          <input
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              setArchive(null)
              clearLocalPreview()
              if (file === undefined) return
              if (file.size > MAX_ARCHIVE_BYTES) {
                setLocalMessage({ key: 'file.tooLarge' })
                return
              }
              void run(setLocalMessage, async () =>
                setArchive(base64(new Uint8Array(await file.arrayBuffer()))),
              )
            }}
          />
        </label>
        <label>
          {t('cwd.local')}
          <input
            value={localCwd}
            disabled={busy}
            onChange={(event) => {
              setLocalCwd(event.target.value)
              clearLocalPreview()
            }}
            spellCheck={false}
          />
        </label>
        {localPreview !== null ? <Preview preview={localPreview} t={t} /> : null}
        {localPreview !== null ? trustCheckbox(localTrust, setLocalTrust) : null}
        {localMessage !== null ? <p role="status">{messageText(localMessage, t)}</p> : null}
        <div className={styles.actions}>
          <Button
            variant="outline"
            disabled={busy || archive === null || !localCwd.trim()}
            onClick={() =>
              void run(setLocalMessage, async () => {
                clearLocalPreview()
                setLocalPreview(
                  await api.request<ArchivePreview>(PREVIEW_PATH, {
                    method: 'POST',
                    body: JSON.stringify({ archive, cwd: localCwd }),
                  }),
                )
              })
            }
          >
            {t('preview')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !localReady || !localTrust}
            onClick={() => void run(setLocalMessage, importLocal)}
          >
            {t('import')}
          </Button>
        </div>
      </section>
      <section className={styles.section}>
        <h3>{t('remote.title')}</h3>
        <label>
          {t('remote.target')}
          <select
            value={remoteId}
            disabled={busy}
            onChange={(event) => {
              setRemoteId(event.target.value)
              clearRemotePreview()
            }}
          >
            <option value="">{t('choose')}</option>
            {remotes.map((remote) => (
              <option key={remote.id} value={remote.id}>
                {remote.label}
                {remote.reason === undefined ? '' : ` · ${t(`remote.${remote.reason}`)}`}
              </option>
            ))}
          </select>
        </label>
        {target !== undefined ? (
          <p className={styles.identity}>
            <code>{target.id}</code>
            {target.reason !== undefined ? <span>{t(`remote.${target.reason}`)}</span> : null}
            {target.detail !== undefined ? <span>{target.detail}</span> : null}
          </p>
        ) : null}
        <label>
          {t('cwd.remote')}
          <input
            value={remoteCwd}
            disabled={busy}
            onChange={(event) => {
              setRemoteCwd(event.target.value)
              clearRemotePreview()
            }}
            spellCheck={false}
          />
        </label>
        {!remoteAvailable ? (
          <p>{t('remote.missing')}</p>
        ) : remotes.length === 0 ? (
          <p>{t('remote.empty')}</p>
        ) : null}
        {remoteError !== null ? <p role="alert">{remoteError}</p> : null}
        {remotePreview !== null ? <Preview preview={remotePreview} t={t} /> : null}
        {remotePreview !== null ? trustCheckbox(remoteTrust, setRemoteTrust) : null}
        {remoteMessage !== null ? <p role="status">{messageText(remoteMessage, t)}</p> : null}
        <div className={styles.actions}>
          <Button
            variant="outline"
            disabled={busy || !source || !target?.available || !remoteCwd.trim()}
            onClick={() => void run(setRemoteMessage, previewRemote)}
          >
            {t('preview')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !target?.available || !remoteReady || !remoteTrust}
            onClick={() => void run(setRemoteMessage, importRemote)}
          >
            {t('transfer')}
          </Button>
        </div>
      </section>
      {busy ? <p role="status">{t('working')}</p> : null}
    </Panel>
  )
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sessions: locale')
  const t = ctx.locale.bind(NS)
  // 两个 half 的同名 sessions 在联合类型检查中相遇；浏览器入口只持有官方 ISessions。
  const sessions = ctx.sessions as unknown as ISessions
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: NS,
        order: 46,
        label: () => t('section.label'),
        locale: NS,
        inject: () => ({ onImported: () => sessions.refresh() }),
      },
      SessionSection,
    ),
  )
}
