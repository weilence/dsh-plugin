import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { IssueList, TextField } from '@dsh-plugins/client-ui'
import type { ConnRow, SaveRequest } from '../shared'
import type { RemoteT } from './locales'
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

function validateDraft(draft: DraftState, t: RemoteT): string[] {
  const issues: string[] = []
  if (draft.label.trim().length === 0) issues.push(t('form.labelRequired'))
  if (draft.sshAlias.trim().length === 0) issues.push(t('form.aliasRequired'))
  return issues
}

export function RemoteForm(props: {
  mode: 'create' | 'edit'
  row?: ConnRow
  store: RemoteStore
  t: RemoteT
  busy: boolean
  error: string | null
  onDone(): void
  onCancel(): void
}) {
  const [draft, setDraft] = useState<DraftState>(() => initialDraft(props.row))
  const [touched, setTouched] = useState(false)
  const issues = validateDraft(draft, props.t)
  const patch = (partial: Partial<DraftState>): void => setDraft((previous) => ({ ...previous, ...partial }))

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (issues.length > 0) return
    const request: SaveRequest = {
      id: props.mode === 'edit' ? props.row?.id : undefined,
      label: draft.label.trim(),
      sshAlias: draft.sshAlias.trim(),
    }
    if (await props.store.save(request)) props.onDone()
  }

  return (
    <div className={styles.formBody}>
      <div className={styles.grid}>
        <TextField
          label={props.t('form.label')}
          value={draft.label}
          onChange={(label) => patch({ label })}
          autoFocus={props.mode === 'create'}
          placeholder={props.t('form.labelPlaceholder')}
        />
        <TextField
          label={props.t('form.sshAlias')}
          value={draft.sshAlias}
          onChange={(sshAlias) => patch({ sshAlias })}
          placeholder={props.t('form.sshAliasPlaceholder')}
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
          {props.t('cancel')}
        </Button>
        <Button variant="primary" disabled={props.busy} onClick={() => void submit()}>
          {props.busy ? props.t('form.saving') : props.t('save')}
        </Button>
      </div>
    </div>
  )
}
