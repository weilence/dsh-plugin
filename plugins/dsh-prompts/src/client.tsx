import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Panel, useWideSettingsDialog } from '@dsh-plugins/client-ui'
import { createBridgeClient } from '@dsh-plugins/shared/api'
import { errMsg } from '@dsh-plugins/shared'
import { DELETE_PATH, FILE_PATH, SAVE_PATH, type PromptFile } from './shared'
import { NS, en, zh, type PromptsT } from './client/locales'
import styles from './client.module.css'

export const inject: string[] = ['slots', 'locale']

const api = createBridgeClient('x-dsh-prompts')

function PromptSection({ t }: { t: PromptsT }) {
  useWideSettingsDialog()
  const [file, setFile] = useState<PromptFile | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // 事件时间取词的即显消息：出现即随当前语言渲染，不跨语言切换存活。
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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

  const refresh = async () => {
    if (dirty && !window.confirm(t('confirm.refresh'))) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.request<PromptFile>(FILE_PATH)
      setFile(result)
      setDraft(result.content)
    } catch (cause) {
      setFile(null)
      setError(t('load.failed', { detail: errMsg(cause) }))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (file === null) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.request<PromptFile>(SAVE_PATH, {
        method: 'POST',
        body: JSON.stringify({ content: draft, revision: file.revision }),
      })
      setFile(result)
      setDraft(result.content)
      setNotice(t('notice.saved'))
    } catch (cause) {
      setError(t('save.failed', { detail: errMsg(cause) }))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (file?.exists !== true || !window.confirm(t('confirm.delete', { path: file.path }))) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.request<PromptFile>(DELETE_PATH, {
        method: 'POST',
        body: JSON.stringify({ revision: file.revision }),
      })
      setFile(result)
      setDraft('')
      setNotice(t('notice.deleted'))
    } catch (cause) {
      setError(t('delete.failed', { detail: errMsg(cause) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={t('title')} subtitle={t('subtitle')}>
      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      ) : null}
      <div className={styles.info}>
        <span>{t('path.label')}</span>
        <code className={styles.path}>
          {file?.path ?? (error === null ? t('path.loading') : t('path.unavailable'))}
        </code>
        {file !== null && !file.exists ? <span>{t('path.absent')}</span> : null}
      </div>
      <label className={styles.editorLabel} htmlFor="dsh-prompts-editor">
        {t('editor.label')}
      </label>
      <textarea
        id="dsh-prompts-editor"
        className={styles.editor}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t('editor.placeholder')}
        disabled={file === null || busy}
        spellCheck={false}
      />
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={file === null || busy || (!dirty && file.exists)}
          onClick={() => void save()}
        >
          {busy ? t('processing') : file?.exists ? t('save') : t('create')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
          {t('refresh')}
        </Button>
        <Button
          variant="outline"
          disabled={file?.exists !== true || busy || dirty}
          title={dirty ? t('delete.dirtyTitle') : undefined}
          onClick={() => void remove()}
        >
          {t('button.deleteFile')}
        </Button>
      </div>
      <p className={styles.hint}>{t('hint')}</p>
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
}
