/**
 * 连接表单：新建 / 编辑共用，只编辑基本信息（label / sshAlias）。远端
 * profile 固定 web、远端 dsh 版本部署时对齐本机，均不暴露输入；三类同步
 * 的勾选清单与插件安装方式在 SyncDialog（同步弹窗）里编辑——同步即保存。
 */

import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { IssueList, TextField } from '@dsh-plugins/client-ui'
import type { ConnRow, SaveRequest } from '../shared'
import type { RemoteStore } from './store'
import local from './RemoteForm.module.css'
import shared from '@dsh-plugins/client-ui/styles'

const styles = { ...shared, ...local }

interface DraftState {
  label: string
  sshAlias: string
}

function initialDraft(row: ConnRow | undefined): DraftState {
  return {
    label: row?.label ?? '',
    sshAlias: row?.sshAlias ?? '',
  }
}

function validateDraft(draft: DraftState): string[] {
  const issues: string[] = []
  if (draft.label.trim().length === 0) issues.push('显示名不能为空')
  if (draft.sshAlias.trim().length === 0) issues.push('sshAlias 不能为空（~/.ssh/config 里的主机别名）')
  return issues
}

export function RemoteForm(props: {
  mode: 'create' | 'edit'
  row?: ConnRow
  store: RemoteStore
  busy: boolean
  error: string | null
  onDone(): void
  onCancel(): void
}) {
  const [draft, setDraft] = useState<DraftState>(() => initialDraft(props.row))
  const [touched, setTouched] = useState(false)
  const issues = validateDraft(draft)
  const patch = (partial: Partial<DraftState>): void => setDraft((previous) => ({ ...previous, ...partial }))

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (issues.length > 0) return
    const request: SaveRequest = {
      ...(props.mode === 'edit' && props.row !== undefined ? { id: props.row.id } : {}),
      label: draft.label.trim(),
      sshAlias: draft.sshAlias.trim(),
      // 三类同步清单是 SyncDialog 的职责；编辑基本信息时原样带回
      ...(props.row !== undefined
        ? { sync: { ...props.row.sync } }
        : { sync: { skillNames: [], mcpServerNames: [], pluginNames: [] } }),
    }
    if (await props.store.save(request)) props.onDone()
  }

  return (
    <div className={styles.formBody}>
      <div className={styles.grid}>
        <TextField
          label="显示名"
          value={draft.label}
          onChange={(label) => patch({ label })}
          autoFocus={props.mode === 'create'}
          placeholder="如：开发机 A"
        />
        <TextField
          label="SSH 别名"
          value={draft.sshAlias}
          onChange={(sshAlias) => patch({ sshAlias })}
          placeholder="~/.ssh/config 主机别名"
        />
      </div>

      {touched && issues.length > 0 ? <IssueList issues={issues.map((message) => ({ message }))} /> : null}
      {props.error !== null ? (
        <div className={styles.error} role="alert">
          {props.error}
        </div>
      ) : null}

      <div className={styles.formActions}>
        <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
          取消
        </Button>
        <Button variant="primary" disabled={props.busy} onClick={() => void submit()}>
          {props.busy ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
