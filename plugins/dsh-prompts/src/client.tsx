import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Panel, useWideSettingsDialog } from '@dsh-plugins/client-ui'
import { createBridgeClient } from '@dsh-plugins/shared/api'
import { errMsg } from '@dsh-plugins/shared'
import { DELETE_PATH, FILE_PATH, SAVE_PATH, type PromptFile } from './shared'
import styles from './client.module.css'

export const inject: string[] = ['slots']

const api = createBridgeClient('x-dsh-prompts')

function PromptSection() {
  useWideSettingsDialog()
  const [file, setFile] = useState<PromptFile | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
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
        if (active) setError(`读取全局提示词失败：${errMsg(cause)}`)
      },
    )
    return () => {
      active = false
    }
  }, [])

  const refresh = async () => {
    if (dirty && !window.confirm('刷新会丢弃尚未保存的修改，确定继续吗？')) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.request<PromptFile>(FILE_PATH)
      setFile(result)
      setDraft(result.content)
    } catch (cause) {
      setFile(null)
      setError(`读取全局提示词失败：${errMsg(cause)}`)
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
      setNotice('全局提示词已保存')
    } catch (cause) {
      setError(`保存失败：${errMsg(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (file?.exists !== true || !window.confirm(`确定删除 ${file.path} 吗？此操作不可撤销。`)) return
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
      setNotice('全局提示词已删除')
    } catch (cause) {
      setError(`删除失败：${errMsg(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="全局提示词" subtitle="编辑用户级 AGENTS.md；工作区指令和系统提示词不受影响。">
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
        <span>文件路径</span>
        <code className={styles.path}>{file?.path ?? (error === null ? '读取中…' : '路径不可用')}</code>
        {file !== null && !file.exists ? <span>文件尚不存在，保存后将创建。</span> : null}
      </div>
      <label className={styles.editorLabel} htmlFor="dsh-prompts-editor">
        提示词正文（Markdown）
      </label>
      <textarea
        id="dsh-prompts-editor"
        className={styles.editor}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="在此编写适用于所有工作区的指令…"
        disabled={file === null || busy}
        spellCheck={false}
      />
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={file === null || busy || (!dirty && file.exists)}
          onClick={() => void save()}
        >
          {busy ? '处理中…' : file?.exists ? '保存' : '创建'}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
          刷新
        </Button>
        <Button
          variant="outline"
          disabled={file?.exists !== true || busy || dirty}
          title={dirty ? '请先保存或刷新未保存的修改' : undefined}
          onClick={() => void remove()}
        >
          删除文件
        </Button>
      </div>
      <p className={styles.hint}>
        请确认文件路径与智能体使用的全局目录一致。保存时会检查外部修改；若有冲突，请刷新并自行合并。新内容在下一次尚未开始的模型步骤生效。
      </p>
    </Panel>
  )
}

export function apply(ctx: Context): void {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-prompts',
        order: 45,
        label: () => '全局提示词',
      },
      PromptSection,
    ),
  )
}
