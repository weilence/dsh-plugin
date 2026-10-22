/**
 * 批量操作组件：批量条、删除预览、目标选择弹窗与结果弹窗。
 * 弹窗全部面板局部挂载；提示走 notice，逐项明细只进结果弹窗。
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import sharedStyles from '@dsh-plugins/client-ui/styles'
import { fetchPresets } from './api'
import { messageText, type Message, type SessionsT } from './locales'
import type { BatchOutcome } from './store'
import localStyles from '../client.module.css'

const styles = { ...sharedStyles, ...localStyles }

export function BatchToolbar(props: {
  t: SessionsT
  count: number
  running: boolean
  disabled: boolean
  onSelectVisible(): void
  onClearSelection(): void
  onArchive(): void
  onUnarchive(): void
  onMigrate(): void
  onPreset(): void
  onDelete(): void
}) {
  const { t, count, running, disabled } = props
  const empty = count === 0
  const busy = running || disabled
  return (
    <div className={styles.batchBar}>
      <span className={styles.batchCount}>{t('batch.selected', { count })}</span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={props.onSelectVisible}>
        {t('batch.selectAll')}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy || empty} onClick={props.onClearSelection}>
        {t('batch.clear')}
      </Button>
      <span className={styles.batchDivider} />
      <Button size="sm" variant="outline" disabled={busy || empty} onClick={props.onArchive}>
        {t('archive.archive')}
      </Button>
      <Button size="sm" variant="outline" disabled={busy || empty} onClick={props.onUnarchive}>
        {t('archive.restore')}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy || empty} onClick={props.onMigrate}>
        {t('batch.migrate')}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy || empty} onClick={props.onPreset}>
        {t('batch.preset')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={styles.dangerGhost}
        disabled={busy || empty}
        onClick={props.onDelete}
      >
        {t('archive.delete')}
      </Button>
      {running ? <span role="status">{t('batch.working')}</span> : null}
    </div>
  )
}

export interface BatchTargetView {
  id: SessionId
  title: string
  running: boolean
}

export function BatchDeletePreview(props: {
  t: SessionsT
  targets: readonly BatchTargetView[]
  busy: boolean
  onConfirm(): void
  onCancel(): void
}) {
  const { t, targets, busy } = props
  const runningCount = targets.filter((target) => target.running).length
  return (
    <Modal
      open
      title={t('batch.previewTitle')}
      closeLabel={t('close')}
      onClose={() => {
        if (!busy) props.onCancel()
      }}
      className={styles.batchDialog}
      footer={
        <div className={styles.footer}>
          <div className={styles.feedback}>
            <p className={styles.warning}>{t('batch.previewWarning', { count: targets.length })}</p>
            {runningCount > 0 ? (
              <p role="alert">{t('batch.previewRunning', { count: runningCount })}</p>
            ) : null}
          </div>
          <div className={styles.actions}>
            <Button variant="outline" disabled={busy} onClick={props.onCancel}>
              {t('cancel')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={props.onConfirm}>
              {t('batch.confirmDelete')}
            </Button>
          </div>
        </div>
      }
    >
      <ul className={styles.batchTargets}>
        {targets.map((target) => (
          <li key={target.id}>
            <strong>{target.title}</strong>
            <code>{target.id}</code>
            {target.running ? <span className={styles.badge}>{t('badge.running')}</span> : null}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

export function BatchMigrateDialog(props: {
  t: SessionsT
  workspaces: ReadonlyArray<{ workspaceId: string; title: string; path: string }>
  busy: boolean
  onConfirm(workspaceId: string): void
  onClose(): void
}) {
  const { t, workspaces, busy } = props
  const [workspaceId, setWorkspaceId] = useState('')
  const working = useRef(false)
  const target = workspaces.find((workspace) => workspace.workspaceId === workspaceId)
  return (
    <Modal
      open
      title={t('batch.migrateTitle')}
      closeLabel={t('close')}
      onClose={() => {
        if (!working.current) props.onClose()
      }}
      className={styles.dialog}
      footer={
        <div className={styles.footer}>
          <div className={styles.feedback}>
            <p className={styles.warning}>{t('batch.migrateDescription')}</p>
          </div>
          <div className={styles.actions}>
            <Button variant="outline" disabled={busy} onClick={props.onClose}>
              {t('close')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || target === undefined}
              onClick={() => {
                working.current = true
                props.onConfirm(workspaceId)
              }}
            >
              {t('migrate.confirm')}
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
            disabled={busy}
            onChange={(event) => {
              setWorkspaceId(event.target.value)
            }}
          >
            <option value="">{t('workspace.choose')}</option>
            {workspaces.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.title} — {workspace.path}
              </option>
            ))}
          </select>
        </label>
        {workspaces.length === 0 ? <p>{t('workspace.empty')}</p> : null}
        {target !== undefined ? <code className={styles.path}>{target.path}</code> : null}
      </div>
    </Modal>
  )
}

type PresetPhase =
  { kind: 'loading' } | { kind: 'ready'; presets: string[] } | { kind: 'failed'; message: Message }

export function BatchPresetDialog(props: {
  t: SessionsT
  busy: boolean
  onConfirm(toPreset: string): void
  onClose(): void
}) {
  const { t, busy } = props
  const [phase, setPhase] = useState<PresetPhase>({ kind: 'loading' })
  const [preset, setPreset] = useState('')
  const working = useRef(false)

  useEffect(() => {
    let cancelled = false
    fetchPresets()
      .then((presets) => {
        if (!cancelled) setPhase({ kind: 'ready', presets })
      })
      .catch((error: unknown) => {
        if (!cancelled) setPhase({ kind: 'failed', message: { text: errMsg(error) } })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Modal
      open
      title={t('batch.presetTitle')}
      closeLabel={t('close')}
      onClose={() => {
        if (!working.current) props.onClose()
      }}
      className={styles.dialog}
      footer={
        <div className={styles.footer}>
          <div className={styles.feedback}>
            <p className={styles.warning}>{t('batch.presetDescription')}</p>
          </div>
          <div className={styles.actions}>
            <Button variant="outline" disabled={busy} onClick={props.onClose}>
              {t('close')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || phase.kind !== 'ready' || preset === ''}
              onClick={() => {
                working.current = true
                props.onConfirm(preset)
              }}
            >
              {t('preset.confirm')}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.fields}>
        <label>
          {t('preset.target')}
          <select
            data-modal-autofocus
            value={preset}
            disabled={busy || phase.kind !== 'ready'}
            onChange={(event) => {
              setPreset(event.target.value)
            }}
          >
            <option value="">{t('preset.choose')}</option>
            {phase.kind === 'ready'
              ? phase.presets.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))
              : null}
          </select>
        </label>
        {phase.kind === 'loading' ? (
          <p role="status">{t('preset.loading')}</p>
        ) : phase.kind === 'failed' ? (
          <p role="alert">{messageText(phase.message, t)}</p>
        ) : phase.presets.length === 0 ? (
          <p>{t('preset.empty')}</p>
        ) : null}
      </div>
    </Modal>
  )
}

export function BatchResultDialog(props: {
  t: SessionsT
  outcome: BatchOutcome
  busy: boolean
  onRetry(): void
  onClose(): void
}) {
  const { t, outcome, busy } = props
  const failed = outcome.items.filter((item) => !item.ok)
  const succeeded = outcome.items.filter((item) => item.ok)
  const render = (items: typeof outcome.items): React.ReactNode =>
    items.map((item) => (
      <li key={item.sessionId}>
        <strong>{item.title}</strong>
        <code>{item.sessionId}</code>
        <span>{messageText(item.summary, t)}</span>
      </li>
    ))
  return (
    <Modal
      open
      title={t('batch.resultTitle')}
      closeLabel={t('close')}
      onClose={() => {
        if (!busy) props.onClose()
      }}
      className={styles.batchDialog}
      footer={
        <div className={styles.footer}>
          <div className={styles.actions}>
            {failed.length > 0 ? (
              <Button variant="outline" disabled={busy} onClick={props.onRetry}>
                {t('batch.retry')}
              </Button>
            ) : null}
            <Button variant="primary" disabled={busy} onClick={props.onClose}>
              {t('close')}
            </Button>
          </div>
        </div>
      }
    >
      {busy ? <p role="status">{t('batch.working')}</p> : null}
      {succeeded.length > 0 ? (
        <>
          <h2>{t('batch.success', { count: succeeded.length })}</h2>
          <ul className={styles.batchTargets}>{render(succeeded)}</ul>
        </>
      ) : null}
      {failed.length > 0 ? (
        <>
          <h2>{t('batch.failure', { count: failed.length })}</h2>
          <ul className={styles.batchTargets}>{render(failed)}</ul>
        </>
      ) : null}
    </Modal>
  )
}
