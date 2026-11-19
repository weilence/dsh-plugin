import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ResidentNoticeSlotEntry, useWideSettingsDialog } from '@dsh-plugins/client-ui'
import { NoticeRelay } from '@dsh-plugins/client-ui/notice-relay'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Panel } from '@dsh-plugins/client-ui'
import { createBridgeClient } from '@dsh-plugins/shared/api'
import { errMsg } from '@dsh-plugins/shared'
import { FILE_PATH, SAVE_PATH, type PromptFile } from './shared'
import { NS, en, zh } from './client/locales'
import styles from './client.module.css'

export const inject: string[] = ['slots', 'locale']

const api = createBridgeClient('x-dsh-prompts')

// 一次性成功通知的通道：emit 时按事件时间取词定格（即显一次性反馈的既有约定），
// 由 shell.overlay 常驻显示点（本文件底部注册）订阅显示——设置分区卸载不影响横幅播完。
const notices = new NoticeRelay<string>()

/** 完整组件 props：运行时份额 + locale 标准 seat（本面板无注入面）。 */
type PromptSectionProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS>

function PromptSection({ t }: PromptSectionProps) {
  useWideSettingsDialog()
  const [file, setFile] = useState<PromptFile | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // 事件时间取词的即显消息：出现即随当前语言渲染，不跨语言切换存活。
  const [error, setError] = useState<string | null>(null)
  const dirty = file !== null && draft !== file.content

  useEffect(() => {
    let active = true
    void api.request<PromptFile>(FILE_PATH).then(
      (result) => {
        if (!active) return
        setFile(result)
        setDraft(result.content)
      },
      (cause: unknown) => {
        if (active) setError(t('load.failed', { detail: errMsg(cause) }))
      },
    )
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    if (file === null) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.request<PromptFile>(SAVE_PATH, {
        method: 'POST',
        body: JSON.stringify({ content: draft, revision: file.revision }),
      })
      setFile(result)
      setDraft(result.content)
      notices.emit(t('notice.saved'))
    } catch (cause) {
      setError(t('save.failed', { detail: errMsg(cause) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={t('title')} subtitle={t('subtitle')}>
      <textarea
        id="dsh-prompts-editor"
        className={styles.editor}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t('editor.placeholder')}
        aria-label={t('editor.label')}
        disabled={file === null || busy}
        spellCheck={false}
      />
      {/* 失败反馈贴着动作区：表单长时顶部的提示区在视口外，点了保存看不见被拦的原因。 */}
      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={file === null || busy || (!dirty && file.exists)}
          onClick={() => void save()}
        >
          {busy ? t('processing') : file?.exists ? t('save') : t('create')}
        </Button>
      </div>
    </Panel>
  )
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-prompts: copy dictionaries')
  // 导航 label thunk 用 apply 域绑定；面板的 t 由注册声明 locale 命名空间获得
  // 框架标准 seat（每个语言切换换新引用，memo 组件靠浅比较自动刷新）。
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-prompts',
        order: 45,
        label: () => t('section.label'),
        locale: NS,
      },
      PromptSection,
    ),
  )
  // 一次性通知的常驻显示点：设置分区内不渲染 Toast，反馈在分区关闭前后都能播完。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-prompts.notices',
        inject: () => ({ relay: notices }),
      },
      ResidentNoticeSlotEntry,
    ),
  )
}
