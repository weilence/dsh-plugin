import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ConfirmDialog, Panel, Pill, SelectField, TextField } from '@dsh-plugins/client-ui'
import {
  PROJECT_KEY_PATTERN,
  SITE_NAME_PATTERN,
  type CredentialStateView,
  type SiteDraft,
  type SiteKind,
  type SiteView,
} from '../shared'
import { NS, type AtlassianT } from './locales'
import styles from './SitesSection.module.css'
import type { AtlassianStore, PanelState } from './store'

export interface AtlassianSectionInjected {
  store: AtlassianStore
}

export type SitesSectionProps = PropsRuntime<'plugins.bundle.config'> &
  PropsLocale<typeof NS> &
  InjectFace<AtlassianSectionInjected>

type Editing = { mode: 'new' } | { mode: 'edit'; site: SiteView }

interface FormState {
  name: string
  kind: SiteKind
  /** Cloud：Atlassian 站点地址；Server：Jira 根地址（字段按 kind 二选一使用）。 */
  atlassianUrl: string
  jiraUrl: string
  confluenceUrl: string
  email: string
  projects: string
  workspaces: string
  /** 评论过滤名单：displayName 子串匹配（不区分大小写）。 */
  commentExcludeAuthors: string
  /** Cloud：共用 token；Server：Jira / Confluence 各一份。 */
  jiraToken: string
  confluenceToken: string
  default: boolean
}

interface FormErrors {
  name?: string
  atlassianUrl?: string
  jiraUrl?: string
  confluenceUrl?: string
  email?: string
  projects?: string
}

/** 分隔符宽容（逗号 / 空格 / 中文逗号顿号），统一大写去重；无效键由 validate 拦截。 */
function parseProjects(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\s，、]+/)
        .map((key) => key.trim().toUpperCase())
        .filter((key) => key !== ''),
    ),
  ]
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

/** 作者显示名只按逗号分隔（名字可含空格），去空项保留原样大小写；匹配在查询时不区分大小写。 */
function parseAuthors(text: string): string[] {
  return parseWorkspaces(text)
}

function draftOf(state: FormState): SiteDraft {
  if (state.kind === 'cloud') {
    const draft: SiteDraft = {
      name: state.name.trim(),
      kind: 'cloud',
      atlassianUrl: state.atlassianUrl.trim(),
      email: state.email.trim(),
    }
    const projects = parseProjects(state.projects)
    if (projects.length > 0) draft.projects = projects
    const workspaces = parseWorkspaces(state.workspaces)
    if (workspaces.length > 0) draft.workspaces = workspaces
    const authors = parseAuthors(state.commentExcludeAuthors)
    if (authors.length > 0) draft.commentExcludeAuthors = authors
    if (state.default) draft.default = true
    return draft
  }
  const draft: SiteDraft = {
    name: state.name.trim(),
    kind: 'server',
    jiraUrl: state.jiraUrl.trim(),
    confluenceUrl: state.confluenceUrl.trim(),
  }
  const projects = parseProjects(state.projects)
  if (projects.length > 0) draft.projects = projects
  const workspaces = parseWorkspaces(state.workspaces)
  if (workspaces.length > 0) draft.workspaces = workspaces
  const authors = parseAuthors(state.commentExcludeAuthors)
  if (authors.length > 0) draft.commentExcludeAuthors = authors
  if (state.default) draft.default = true
  return draft
}

/** 行内测试只探测已存凭据：SiteView 转纯 SiteDraft（逐字段携带，地址与凭据引用按 kind 分形）。 */
function draftOfView(site: SiteView): SiteDraft {
  const draft: SiteDraft =
    site.kind === 'cloud'
      ? { name: site.name, kind: 'cloud', atlassianUrl: site.atlassianUrl, email: site.email }
      : {
          name: site.name,
          kind: 'server',
          jiraUrl: site.jiraUrl,
          confluenceUrl: site.confluenceUrl,
        }
  return {
    ...draft,
    atlassianTokenRef: site.atlassianTokenRef,
    jiraTokenRef: site.jiraTokenRef,
    confluenceTokenRef: site.confluenceTokenRef,
    projects: site.projects,
    workspaces: site.workspaces,
    commentExcludeAuthors: site.commentExcludeAuthors,
    default: site.default,
  }
}

/** 新建表单的空白初值：地址留空由校验拦下。 */
const BLANK_SITE: SiteView = {
  name: '',
  kind: 'cloud',
  token: { configured: false },
  confluenceToken: { configured: false },
}

export function SitesSection(props: SitesSectionProps) {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<SiteView | null>(null)

  useEffect(() => {
    void store.refresh()
  }, [store])

  const view = state.view
  const busy = state.busy
  const toggleNew = (): void => {
    store.clearFormError()
    setEditing(editing?.mode === 'new' ? null : { mode: 'new' })
  }

  // 插件详情页的页面头部已是插件名与描述，Panel 整体无头部（根 docs/panel.md 例外条款）。
  return (
    <Panel>
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
    </Panel>
  )
}

function SiteCard(props: {
  site: SiteView
  state: PanelState
  t: AtlassianT
  store: AtlassianStore
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
            <Pill text={site.kind === 'cloud' ? t('site.kindCloud') : t('site.kindServer')} />
            {site.default === true ? <Pill text={t('site.defaultBadge')} tone="brand" /> : null}
            {site.kind === 'cloud' ? (
              <TokenPill
                state={site.token}
                t={t}
                okText="site.tokenConfigured"
                missingText="site.tokenMissing"
              />
            ) : (
              <>
                <TokenPill
                  state={site.token}
                  t={t}
                  okText="site.jiraTokenOk"
                  missingText="site.jiraTokenMissing"
                />
                <TokenPill
                  state={site.confluenceToken}
                  t={t}
                  okText="site.confTokenOk"
                  missingText="site.confTokenMissing"
                />
              </>
            )}
            {(site.projects ?? []).map((key) => (
              <Pill key={key} text={key} />
            ))}
            {(site.workspaces ?? []).length > 0 ? (
              <Pill text={t('site.workspacesBadge', { count: site.workspaces?.length ?? 0 })} />
            ) : null}
            {(site.commentExcludeAuthors ?? []).length > 0 ? (
              <Pill text={t('site.commentFilterBadge', { count: site.commentExcludeAuthors?.length ?? 0 })} />
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
      <div className={styles.url}>
        {site.kind === 'cloud' ? site.atlassianUrl : site.jiraUrl}
        {site.kind === 'server' ? (
          <>
            {' · '}
            {site.confluenceUrl}
          </>
        ) : null}
      </div>
      {test !== undefined ? (
        <div className={styles.testLine}>
          <span className={test.jira.ok ? styles.testOk : styles.testFail}>
            {test.jira.ok ? t('test.jiraOk') : t('test.jiraFail', { reason: test.jira.reason ?? '' })}
          </span>
          <span className={test.confluence.ok ? styles.testOk : styles.testFail}>
            {test.confluence.ok
              ? t('test.confOk')
              : t('test.confFail', { reason: test.confluence.reason ?? '' })}
          </span>
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

function TokenPill(props: {
  state: CredentialStateView
  t: AtlassianT
  okText: 'site.tokenConfigured' | 'site.jiraTokenOk' | 'site.confTokenOk'
  missingText: 'site.tokenMissing' | 'site.jiraTokenMissing' | 'site.confTokenMissing'
}) {
  const { state, t, okText, missingText } = props
  if (state.failure !== undefined) {
    return <Pill text={t(missingText)} tone="err" title={state.failure} />
  }
  if (state.configured) {
    return (
      <Pill
        text={t(okText)}
        tone="ok"
        title={state.source === undefined ? undefined : t('site.tokenSource', { source: state.source })}
      />
    )
  }
  return <Pill text={t(missingText)} tone="warn" />
}

function SiteForm(props: {
  initial: SiteView
  existing: readonly SiteView[]
  busy: boolean
  formError: string | null
  t: AtlassianT
  store: AtlassianStore
  onDone(): void
}) {
  const { initial, existing, busy, formError, t, store, onDone } = props
  const [form, setForm] = useState<FormState>({
    name: initial.name,
    kind: initial.kind,
    atlassianUrl: initial.atlassianUrl ?? '',
    jiraUrl: initial.jiraUrl ?? '',
    confluenceUrl: initial.confluenceUrl ?? '',
    email: initial.email ?? '',
    projects: (initial.projects ?? []).join(', '),
    workspaces: (initial.workspaces ?? []).join(', '),
    commentExcludeAuthors: (initial.commentExcludeAuthors ?? []).join(', '),
    jiraToken: '',
    confluenceToken: '',
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
    if (form.kind === 'cloud') {
      if (form.atlassianUrl.trim() === '') next.atlassianUrl = t('validate.atlassianUrlRequired')
      else if (!checkUrl(form.atlassianUrl)) next.atlassianUrl = t('validate.atlassianUrl')
      if (form.email.trim() === '') next.email = t('validate.email')
    } else {
      if (form.jiraUrl.trim() === '') next.jiraUrl = t('validate.jiraUrlRequired')
      else if (!checkUrl(form.jiraUrl)) next.jiraUrl = t('validate.jiraUrl')
      if (form.confluenceUrl.trim() === '') next.confluenceUrl = t('validate.confluenceRequired')
      else if (!checkUrl(form.confluenceUrl)) next.confluenceUrl = t('validate.confluenceUrl')
    }
    if (parseProjects(form.projects).some((key) => !PROJECT_KEY_PATTERN.test(key))) {
      next.projects = t('validate.projects')
    }
    return next
  }

  const submit = (): void => {
    const next = validate()
    setErrors(next)
    if (Object.keys(next).length > 0) return
    const name = form.name.trim()
    // initial.name 为空即新建表单：不存在旧名，绝不携带 previousName。
    const previousName = initial.name === '' || initial.name === name ? undefined : initial.name
    void store
      .save({
        site: draftOf(form),
        token: form.jiraToken === '' ? undefined : form.jiraToken,
        confluenceToken:
          form.kind === 'server' && form.confluenceToken !== '' ? form.confluenceToken : undefined,
        previousName,
      })
      .then((result) => {
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
      <SelectField
        label={t('form.kind')}
        value={form.kind}
        options={[
          { value: 'cloud', label: t('site.kindCloud') },
          { value: 'server', label: t('site.kindServer') },
        ]}
        onChange={(value) => patch({ kind: value })}
        disabled={busy}
      />
      {form.kind === 'cloud' ? (
        <TextField
          label={t('form.atlassianUrl')}
          value={form.atlassianUrl}
          onChange={(value) => patch({ atlassianUrl: value })}
          error={errors.atlassianUrl}
          hint={t('form.atlassianUrlHint')}
          disabled={busy}
        />
      ) : (
        <TextField
          label={t('form.jiraUrl')}
          value={form.jiraUrl}
          onChange={(value) => patch({ jiraUrl: value })}
          error={errors.jiraUrl}
          hint={t('form.jiraUrlHint')}
          disabled={busy}
        />
      )}
      {form.kind === 'server' ? (
        <TextField
          label={t('form.confluenceUrl')}
          value={form.confluenceUrl}
          onChange={(value) => patch({ confluenceUrl: value })}
          error={errors.confluenceUrl}
          hint={t('form.confluenceUrlHint')}
          disabled={busy}
        />
      ) : null}
      {form.kind === 'cloud' ? (
        <TextField
          label={t('form.email')}
          value={form.email}
          onChange={(value) => patch({ email: value })}
          error={errors.email}
          hint={t('form.emailHint')}
          disabled={busy}
        />
      ) : null}
      {form.kind === 'cloud' ? (
        <TextField
          label={t('form.token')}
          type="password"
          value={form.jiraToken}
          onChange={(value) => patch({ jiraToken: value })}
          hint={initial.token.configured ? t('form.tokenStored') : t('form.tokenHint')}
          disabled={busy}
          autoComplete="off"
          addon={
            initial.token.configured
              ? {
                  label: t('form.eraseToken'),
                  disabled: busy,
                  onClick: () => {
                    void store.clearToken(initial.name, 'jira').then((result) => {
                      if (result.ok) store.notices.emit(t('notice.tokenCleared', { name: initial.name }))
                    })
                  },
                }
              : undefined
          }
        />
      ) : (
        <>
          <TextField
            label={t('form.tokenJira')}
            type="password"
            value={form.jiraToken}
            onChange={(value) => patch({ jiraToken: value })}
            hint={initial.token.configured ? t('form.tokenJiraStored') : t('form.tokenJiraHint')}
            disabled={busy}
            autoComplete="off"
            addon={
              initial.token.configured
                ? {
                    label: t('form.eraseToken'),
                    disabled: busy,
                    onClick: () => {
                      void store.clearToken(initial.name, 'jira').then((result) => {
                        if (result.ok) store.notices.emit(t('notice.tokenCleared', { name: initial.name }))
                      })
                    },
                  }
                : undefined
            }
          />
          <TextField
            label={t('form.tokenConfluence')}
            type="password"
            value={form.confluenceToken}
            onChange={(value) => patch({ confluenceToken: value })}
            hint={
              initial.confluenceToken.configured
                ? t('form.tokenConfluenceStored')
                : t('form.tokenConfluenceHint')
            }
            disabled={busy}
            autoComplete="off"
            addon={
              initial.confluenceToken.configured
                ? {
                    label: t('form.eraseToken'),
                    disabled: busy,
                    onClick: () => {
                      void store.clearToken(initial.name, 'confluence').then((result) => {
                        if (result.ok) store.notices.emit(t('notice.tokenCleared', { name: initial.name }))
                      })
                    },
                  }
                : undefined
            }
          />
        </>
      )}
      <TextField
        label={t('form.projects')}
        value={form.projects}
        onChange={(value) => patch({ projects: value })}
        error={errors.projects}
        hint={t('form.projectsHint')}
        disabled={busy}
        wide
      />
      <TextField
        label={t('form.workspaces')}
        value={form.workspaces}
        onChange={(value) => patch({ workspaces: value })}
        hint={t('form.workspacesHint')}
        disabled={busy}
        wide
      />
      <TextField
        label={t('form.commentFilter')}
        value={form.commentExcludeAuthors}
        onChange={(value) => patch({ commentExcludeAuthors: value })}
        hint={t('form.commentFilterHint')}
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
