import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ConfirmDialog, NoticeToast, Panel, Pill, TextField, useNotice } from '@dsh-plugins/client-ui'
import { SITE_NAME_PATTERN, type SiteDraft, type SiteView } from '../shared'
import { NS, type GitlabT } from './locales'
import styles from './SitesSection.module.css'
import type { GitlabStore, PanelState } from './store'

export interface GitlabSectionInjected {
  store: GitlabStore
}

export type SitesSectionProps = PropsRuntime<'plugins.bundle.config'> &
  PropsLocale<typeof NS> &
  InjectFace<GitlabSectionInjected>

type Editing = { mode: 'new' } | { mode: 'edit'; site: SiteView }

interface FormState {
  name: string
  url: string
  workspaces: string
  default: boolean
}

interface FormErrors {
  name?: string
  url?: string
}

/** 路径只按逗号分隔（路径本身可含空格），去空项保留原样大小写。 */
function parseWorkspaces(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，]+/)
        .map((path) => path.trim())
        .filter((path) => path !== ''),
    ),
  ]
}

function draftOf(state: FormState): SiteDraft {
  const draft: SiteDraft = { name: state.name.trim(), url: state.url.trim() }
  const workspaces = parseWorkspaces(state.workspaces)
  if (workspaces.length > 0) draft.workspaces = workspaces
  if (state.default) draft.default = true
  return draft
}

/** 行内测试复用已存站点：SiteView 转纯 SiteDraft（逐字段携带）。 */
function draftOfView(site: SiteView): SiteDraft {
  return {
    name: site.name,
    url: site.url,
    workspaces: site.workspaces,
    default: site.default,
  }
}

/** 新建表单的空白初值：地址留空由校验拦下。 */
const BLANK_SITE: SiteView = { name: '', url: '' }

export function SitesSection(props: SitesSectionProps) {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<SiteView | null>(null)

  useEffect(() => {
    void store.refresh()
  }, [store])
  // 一次性操作反馈：订阅对齐分区挂载 / 卸载，重开详情页不重放旧 toast。
  const { notice: actionNotice, dismiss: dismissActionNotice } = useNotice(store.notices)

  const view = state.view
  const busy = state.busy
  const toggleNew = (): void => {
    store.clearFormError()
    setEditing(editing?.mode === 'new' ? null : { mode: 'new' })
  }

  // 插件详情页的页面头部已是插件名与描述，Panel 整体无头部（根 docs/panel.md 例外条款）。
  return (
    <Panel>
      <GlabStatusLine
        status={view?.glab}
        loading={state.loading}
        t={t}
        onRefresh={() => void store.refresh()}
      />
      <div className={styles.toolbar}>
        <Button variant="primary" disabled={busy} onClick={toggleNew}>
          {t('action.new')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void store.refresh()}>
          {t('action.refresh')}
        </Button>
      </div>

      {editing?.mode === 'new' ? (
        <div className={styles.card}>
          <SiteForm
            initial={BLANK_SITE}
            existing={view?.sites ?? []}
            busy={busy}
            formError={state.formError}
            t={t}
            store={store}
            onDone={() => {
              store.clearFormError()
              setEditing(null)
            }}
          />
        </div>
      ) : null}

      {state.loadError !== null ? <p className={styles.rowError}>{state.loadError}</p> : null}
      {state.loading ? <p className={styles.hint}>{t('list.loading')}</p> : null}
      {view !== null && !state.loading && view.sites.length === 0 ? (
        <p className={styles.empty}>{t('list.empty')}</p>
      ) : null}
      {view !== null && view.problems.length > 0 ? (
        <div className={styles.problems}>
          {t('problems.title')}
          <ul className={styles.problemsList}>
            {view.problems.map((problem, index) => (
              <li key={index}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.list}>
        {view?.sites.map((site) => (
          <SiteCard
            key={site.name}
            site={site}
            state={state}
            t={t}
            store={store}
            editing={editing}
            setEditing={setEditing}
            onDelete={() => setDeleting(site)}
          />
        ))}
      </div>

      {deleting !== null ? (
        <ConfirmDialog
          title={t('delete.title', { name: deleting.name })}
          body={t('delete.body')}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            void store.remove(deleting.name).then((result) => {
              if (result.ok) {
                store.notices.emit(t('notice.deleted', { name: deleting.name }))
                setDeleting(null)
              }
            })
          }}
        />
      ) : null}

      <NoticeToast notice={actionNotice} text={(message) => message} onDismiss={dismissActionNotice} />
    </Panel>
  )
}

/** glab 环境状态行：找到显示路径与版本；未找到显示指引（安装后点刷新重探测）。 */
function GlabStatusLine(props: {
  status: { path: string | null; version?: string; error?: string } | undefined
  loading: boolean
  t: GitlabT
  onRefresh(): void
}) {
  const { status, loading, t, onRefresh } = props
  if (status === undefined) {
    return loading ? null : <p className={styles.hint}>{t('list.loading')}</p>
  }
  if (status.path === null) {
    return (
      <div className={styles.glabMissing}>
        <p className={styles.rowError}>{t('glab.missing', { error: status.error ?? '' })}</p>
        <p className={styles.hint}>{t('glab.missingHint')}</p>
        <Button variant="outline" onClick={onRefresh}>
          {t('action.refresh')}
        </Button>
      </div>
    )
  }
  return (
    <p className={styles.glabLine}>
      {status.error === undefined
        ? t('glab.found', { path: status.path, version: status.version ?? '-' })
        : t('glab.broken', { path: status.path, error: status.error })}
    </p>
  )
}

function SiteCard(props: {
  site: SiteView
  state: PanelState
  t: GitlabT
  store: GitlabStore
  editing: Editing | null
  setEditing(editing: Editing | null): void
  onDelete(): void
}) {
  const { site, state, t, store, editing, setEditing, onDelete } = props
  const test = state.testResults[site.name]
  const rowError = state.rowErrors[site.name]
  const editingThis = editing?.mode === 'edit' && editing.site.name === site.name
  const toggleEdit = (): void => {
    store.clearFormError()
    setEditing(editingThis ? null : { mode: 'edit', site })
  }
  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <button type="button" className={styles.rowMain} onClick={toggleEdit}>
          <span className={styles.name}>{site.name}</span>
          <span className={styles.badges}>
            {site.default === true ? <Pill text={t('site.defaultBadge')} tone="brand" /> : null}
            {(site.workspaces ?? []).length > 0 ? (
              <Pill text={t('site.workspacesBadge', { count: site.workspaces?.length ?? 0 })} />
            ) : null}
          </span>
        </button>
        <span className={styles.actions}>
          <Button
            variant="outline"
            disabled={state.busy || state.testing !== null}
            onClick={() => void store.test(draftOfView(site))}
          >
            {state.testing === site.name ? t('action.testing') : t('action.test')}
          </Button>
          <Button variant="outline" disabled={state.busy} onClick={toggleEdit}>
            {t('action.edit')}
          </Button>
          <Button variant="outline" disabled={state.busy} onClick={onDelete}>
            {t('delete')}
          </Button>
        </span>
      </div>
      <div className={styles.url}>{site.url}</div>
      {test !== undefined ? (
        <div className={styles.testLine}>
          <span className={test.ok ? styles.testOk : styles.testFail}>
            {test.ok
              ? t('test.ok', { user: test.user ?? '' })
              : t('test.fail', { reason: test.reason ?? '' })}
          </span>
          {!test.ok ? <span className={styles.hint}>{t('test.hint')}</span> : null}
        </div>
      ) : null}
      {rowError !== undefined ? <p className={styles.rowError}>{rowError}</p> : null}
      {editingThis && editing?.mode === 'edit' ? (
        <SiteForm
          initial={editing.site}
          existing={state.view?.sites ?? []}
          busy={state.busy}
          formError={state.formError}
          t={t}
          store={store}
          onDone={() => {
            store.clearFormError()
            setEditing(null)
          }}
        />
      ) : null}
    </div>
  )
}

function SiteForm(props: {
  initial: SiteView
  existing: readonly SiteView[]
  busy: boolean
  formError: string | null
  t: GitlabT
  store: GitlabStore
  onDone(): void
}) {
  const { initial, existing, busy, formError, t, store, onDone } = props
  const [form, setForm] = useState<FormState>({
    name: initial.name,
    url: initial.url,
    workspaces: (initial.workspaces ?? []).join(', '),
    default: initial.default === true,
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const patch = (partial: Partial<FormState>): void => setForm({ ...form, ...partial })

  const validate = (): FormErrors => {
    const next: FormErrors = {}
    const name = form.name.trim()
    if (!SITE_NAME_PATTERN.test(name)) next.name = t('validate.name')
    else if (existing.some((site) => site.name === name && site.name !== initial.name)) {
      next.name = t('validate.duplicate', { name })
    }
    const checkUrl = (value: string): boolean => {
      try {
        const parsed = new URL(value.trim())
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch {
        return false
      }
    }
    if (form.url.trim() === '') next.url = t('validate.urlRequired')
    else if (!checkUrl(form.url)) next.url = t('validate.url')
    return next
  }

  const submit = (): void => {
    const next = validate()
    setErrors(next)
    if (Object.keys(next).length > 0) return
    const name = form.name.trim()
    // initial.name 为空即新建表单：不存在旧名，绝不携带 previousName。
    const previousName = initial.name === '' || initial.name === name ? undefined : initial.name
    void store.save({ site: draftOf(form), previousName }).then((result) => {
      if (result.ok) {
        store.notices.emit(t('notice.saved', { name }))
        onDone()
      }
    })
  }

  return (
    <form
      className={styles.formGrid}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <TextField
        label={t('form.name')}
        value={form.name}
        onChange={(value) => patch({ name: value })}
        error={errors.name}
        hint={t('form.nameHint')}
        disabled={busy}
      />
      <TextField
        label={t('form.url')}
        value={form.url}
        onChange={(value) => patch({ url: value })}
        error={errors.url}
        hint={t('form.urlHint')}
        disabled={busy}
      />
      <TextField
        label={t('form.workspaces')}
        value={form.workspaces}
        onChange={(value) => patch({ workspaces: value })}
        hint={t('form.workspacesHint')}
        disabled={busy}
        wide
      />
      <div className={styles.full}>
        <Checkbox
          checked={form.default}
          disabled={busy}
          label={t('form.default')}
          onChange={(checked) => patch({ default: checked })}
        />
        <p className={styles.hint}>{t('form.defaultHint')}</p>
      </div>
      <div className={styles.formActions}>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? t('action.saving') : t('save')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onDone}>
          {t('cancel')}
        </Button>
        {formError !== null ? <span className={styles.formError}>{formError}</span> : null}
      </div>
    </form>
  )
}
