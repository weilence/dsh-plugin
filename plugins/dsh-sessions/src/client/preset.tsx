/** 预设迁移弹窗：打开时一次性拉取宿主预设清单再渲染，目标预设经宿主侧校验。 */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import sharedStyles from '@dsh-plugins/client-ui/styles'
import { fetchPresets, migrateSessionPreset } from './api'
import { messageText, type Message, type SessionsT } from './locales'
import localStyles from '../client.module.css'

const styles = { ...sharedStyles, ...localStyles }

export interface PresetTarget {
  sessionId: SessionId
  title: string
}

type PresetPhase =
  { kind: 'loading' } | { kind: 'ready'; presets: string[] } | { kind: 'failed'; message: Message }

export function PresetDialog({
  t,
  target,
  onClose,
}: {
  t: SessionsT
  target: PresetTarget
  onClose: () => void
}) {
  const [phase, setPhase] = useState<PresetPhase>({ kind: 'loading' })
  const [preset, setPreset] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Message | null>(null)
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

  const submit = async () => {
    if (working.current || preset === '') return
    if (phase.kind !== 'ready') return
    working.current = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await migrateSessionPreset(target.sessionId, preset)
      setNotice(
        result.migrated
          ? {
              key: 'preset.done',
              params: { title: target.title, from: result.oldPreset ?? '—', to: result.newPreset },
            }
          : { key: 'preset.unchanged', params: { title: target.title, preset: result.newPreset } },
      )
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
      title={t('preset.title')}
      closeLabel={t('close')}
      onClose={() => {
        if (!working.current) onClose()
      }}
      className={styles.dialog}
      footer={
        <div className={styles.footer}>
          <div className={styles.feedback} aria-live="polite">
            {/* 提示信息统一走 notice（官方 Toast，z-1100 盖过 Modal 的 1000 遮罩）；成功与失败同流。 */}
            {notice !== null ? (
              <Toast
                key={messageText(notice, t)}
                text={messageText(notice, t)}
                holdMs={5000}
                onDone={() => setNotice(null)}
              />
            ) : null}
            {busy ? <p role="status">{t('preset.working')}</p> : null}
          </div>
          <div className={styles.actions}>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t('close')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || phase.kind !== 'ready' || preset === ''}
              onClick={() => void submit()}
            >
              {t('preset.confirm')}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.fields}>
        <p className={styles.warning}>{t('preset.description')}</p>
        <label>
          {t('preset.target')}
          <select
            data-modal-autofocus
            value={preset}
            disabled={busy || phase.kind !== 'ready'}
            onChange={(event) => {
              setPreset(event.target.value)
              setNotice(null)
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
