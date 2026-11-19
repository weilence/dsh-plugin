/** 预设迁移弹窗：打开时一次性拉取宿主预设清单与加载探针再渲染，目标预设经宿主侧校验。 */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import sharedStyles from '@dsh-plugins/client-ui/styles'
import { fetchPresets, migrateSessionPreset } from './api'
import { useLoadProbe } from './loaded'
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
  probeSessionLoaded,
  onSuccess,
  onClose,
}: {
  t: SessionsT
  target: PresetTarget
  probeSessionLoaded: (sessionId: SessionId, signal?: AbortSignal) => Promise<boolean>
  /** 上报成功结果：常驻条目据此弹出成功横幅并关闭弹窗。 */
  onSuccess: (message: Message) => void
  onClose: () => void
}) {
  const [phase, setPhase] = useState<PresetPhase>({ kind: 'loading' })
  // 已加载闸门：probing 期间禁用提交，loaded 禁用并给行内原因，探测失败按「未知」放行。
  const loadPhase = useLoadProbe(probeSessionLoaded, target.sessionId)
  const [preset, setPreset] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Message | null>(null)
  const working = useRef(false)
  const loadBlocked = loadPhase === 'probing' || loadPhase === 'loaded'

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
    if (working.current || preset === '' || loadBlocked) return
    if (phase.kind !== 'ready') return
    working.current = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await migrateSessionPreset(target.sessionId, preset)
      onSuccess(
        result.migrated
          ? {
              key: 'preset.done',
              params: { title: target.title, from: result.oldPreset ?? '—', to: result.newPreset },
            }
          : { key: 'preset.unchanged', params: { title: target.title, preset: result.newPreset } },
      )
    } catch (error) {
      // 失败行内常驻（不随时间消失），弹窗保持打开供直接重试；重试或改选时清空。
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
            {/* 失败与校验反馈行内常驻（不随时间消失，重试/改选时清空）；成功走常驻条目的横幅并关闭弹窗。 */}
            {notice !== null ? <p role="alert">{messageText(notice, t)}</p> : null}
            {busy ? <p role="status">{t('preset.working')}</p> : null}
          </div>
          <div className={styles.actions}>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t('close')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || phase.kind !== 'ready' || preset === '' || loadBlocked}
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
        {loadPhase === 'probing' ? <p role="status">{t('session.probeLoading')}</p> : null}
        {loadPhase === 'loaded' ? <p role="alert">{t('session.loadedBlocking')}</p> : null}
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
