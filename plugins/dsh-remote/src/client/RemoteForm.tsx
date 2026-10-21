import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import {
  Button,
  Checkbox,
  SegmentedControl,
  SettingsSecretField,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Dialog, IssueList, SearchBox, TextField } from '@dsh-plugins/client-ui'
import {
  SSH_ALIAS_PATTERN,
  loginKindOf,
  sshHostMeta,
  type ConnRow,
  type ConnectionTarget,
  type LoginKind,
  type SaveRequest,
  type SshHostEntry,
  type TestRequest,
} from '../shared'
import { messageText } from './locales'
import type { RemoteT } from './locales'
import type { RemoteStore } from './store'
import local from './RemoteForm.module.css'
import shared from '@dsh-plugins/client-ui/styles'

const styles = { ...shared, ...local }

/** 客户端的快速校验（权威校验在 host：私钥文件是否存在只有 host 能判断）。 */
const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/
const USER_PATTERN = /^[A-Za-z0-9._-]+$/
const HOST_PORT_SUFFIX = /^[^:]+:\d+$/

interface Draft {
  label: string
  login: LoginKind
  alias: string
  host: string
  port: string
  user: string
  identityFile: string
  /** 新输入的口令；留空 = 沿用已有（除非 clearSecret）。 */
  secret: string
  /** 用户点了「清除已保存的口令」：保存时显式清除。 */
  clearSecret: boolean
  rememberSecret: boolean
}

function initialDraft(row: ConnRow | undefined): Draft {
  const target = row?.target
  return {
    label: row?.label ?? '',
    login: target === undefined ? 'alias' : loginKindOf(target),
    alias: target?.kind === 'alias' ? target.alias : '',
    host: target?.kind === 'direct' ? target.host : '',
    port: target?.kind === 'direct' && target.port !== null ? String(target.port) : '',
    user: target?.kind === 'direct' && target.user !== null ? target.user : '',
    identityFile: target?.kind === 'direct' && target.identityFile !== null ? target.identityFile : '',
    secret: '',
    clearSecret: false,
    rememberSecret: row?.rememberSecret ?? false,
  }
}

/** 编辑已有连接时，「已有口令」只在与当前认证方式一致时可复用（私钥口令
 *  与登录密码不是一回事）。 */
function reusableSecretOf(row: ConnRow | undefined, draft: Draft): boolean {
  if (row === undefined || draft.clearSecret) return false
  return row.target.kind === 'direct' && row.target.auth === draft.login && row.secretState !== 'none'
}

function targetIssues(draft: Draft, reusableSecret: boolean, passwordNeeded: boolean, t: RemoteT): string[] {
  const issues: string[] = []
  if (draft.login === 'alias') {
    if (draft.alias.trim().length === 0) issues.push(t('form.aliasRequired'))
    else if (!SSH_ALIAS_PATTERN.test(draft.alias.trim())) issues.push(t('form.aliasRequired'))
    return issues
  }
  const host = draft.host.trim()
  if (host.length === 0) issues.push(t('form.hostRequired'))
  else if (host.length > 255 || !HOST_PATTERN.test(host) || host.startsWith('-'))
    issues.push(t('form.hostInvalid'))
  else if (HOST_PORT_SUFFIX.test(host)) issues.push(t('form.portInvalid'))
  const port = draft.port.trim()
  if (port.length > 0) {
    const value = Number(port)
    if (!/^\d+$/.test(port) || !Number.isInteger(value) || value < 1 || value > 65535) {
      issues.push(t('form.portInvalid'))
    }
  }
  const user = draft.user.trim()
  if (user.length > 0 && (!USER_PATTERN.test(user) || user.startsWith('-'))) {
    issues.push(t('form.userInvalid'))
  }
  if (draft.login === 'key' && draft.identityFile.trim().length === 0) {
    issues.push(t('form.keyFileRequired'))
  }
  // 只有「新建」或「切换到密码认证」才强制填密码：编辑一个本来就没有口令的
  // 连接（宿主重启后 / 用户主动清除）应当能直接保存，连接时再由面板补录。
  if (passwordNeeded && draft.secret.length === 0 && !reusableSecret && !draft.clearSecret) {
    issues.push(t('form.passwordRequired'))
  }
  return issues
}

function buildTarget(draft: Draft): ConnectionTarget {
  if (draft.login === 'alias') return { kind: 'alias', alias: draft.alias.trim() }
  const port = draft.port.trim()
  return {
    kind: 'direct',
    host: draft.host.trim(),
    port: port.length === 0 ? null : Number(port),
    user: draft.user.trim().length === 0 ? null : draft.user.trim(),
    auth: draft.login,
    identityFile: draft.login === 'key' ? draft.identityFile.trim() : null,
  }
}

/** 保存时提交的口令：'' = 清除；undefined = 保持不变。 */
function secretForSave(draft: Draft, row: ConnRow | undefined): string | undefined {
  if (draft.clearSecret) return ''
  if (draft.secret.length > 0) return draft.secret
  if (draft.login === 'alias') return ''
  const previousAuth = row?.target.kind === 'direct' ? row.target.auth : null
  if (previousAuth !== null && previousAuth !== draft.login) return ''
  return undefined
}

export function RemoteForm(props: {
  mode: 'create' | 'edit'
  row?: ConnRow
  store: RemoteStore
  t: RemoteT
  busy: boolean
  onDone(): void
  onCancel(): void
}) {
  const state = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const [draft, setDraft] = useState<Draft>(() => initialDraft(props.row))
  const [touched, setTouched] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const loginId = useId()
  const secretId = useId()
  const reusableSecret = reusableSecretOf(props.row, draft)
  const previousIsPassword = props.row?.target.kind === 'direct' && props.row.target.auth === 'password'
  const passwordNeeded = draft.login === 'password' && (props.mode === 'create' || !previousIsPassword)
  const issues = targetIssues(draft, reusableSecret, passwordNeeded, props.t)
  const labelIssues = draft.label.trim().length === 0 ? [props.t('form.labelRequired')] : []
  const patch = (partial: Partial<Draft>): void => {
    setDraft((previous) => ({ ...previous, ...partial }))
  }

  useEffect(() => {
    void props.store.loadSshHosts()
  }, [props.store])

  const routerError = state.error === null ? null : messageText(state.error, props.t)
  const busy = props.busy || state.testing
  const hosts = state.sshHosts?.hosts ?? []

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (labelIssues.length > 0 || issues.length > 0) return
    const request: SaveRequest = {
      id: props.mode === 'edit' ? props.row?.id : undefined,
      label: draft.label.trim(),
      target: buildTarget(draft),
      rememberSecret: draft.login === 'alias' ? false : draft.rememberSecret,
      secret: secretForSave(draft, props.row),
    }
    if (await props.store.save(request)) props.onDone()
  }

  const test = (): void => {
    setTouched(true)
    if (issues.length > 0) return
    const reusable = reusableSecretOf(props.row, draft)
    const request: TestRequest = {
      target: buildTarget(draft),
      ...(reusable && props.row !== undefined ? { id: props.row.id } : {}),
      ...(draft.secret.length > 0 ? { secret: draft.secret } : {}),
    }
    void props.store.testDraft(request)
  }

  const configHint = (): string | null => {
    if (state.sshHostsLoading) return props.t('form.configLoading')
    if (state.sshHostsError !== null) {
      return props.t('form.configError', {
        path: state.sshHosts?.path ?? '~/.ssh/config',
        detail: messageText(state.sshHostsError, props.t),
      })
    }
    if (state.sshHosts === null) return null
    if (!state.sshHosts.exists) return props.t('form.configMissing', { path: state.sshHosts.path })
    return props.t('form.configHint', { path: state.sshHosts.path, count: state.sshHosts.hosts.length })
  }

  const pickerRows = (): SshHostEntry[] => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return hosts
    return hosts.filter(
      (host) =>
        host.alias.toLowerCase().includes(needle) ||
        (host.hostname ?? '').toLowerCase().includes(needle) ||
        (host.user ?? '').toLowerCase().includes(needle),
    )
  }

  const hint = configHint()

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
        {/* 分段控件不套 Field（<label> 包住 tablist，点标签会误触第一段）：
            用与 Field 同形态的 label 文本 + 控件本身。 */}
        <div className={local.loginField}>
          <span className={styles.label}>{props.t('form.login')}</span>
          <SegmentedControl
            id={loginId}
            label={props.t('form.login')}
            value={draft.login}
            options={[
              { value: 'alias', label: props.t('form.login.alias') },
              { value: 'password', label: props.t('form.login.password') },
              { value: 'key', label: props.t('form.login.key') },
            ]}
            onChange={(login) => patch({ login, secret: '', clearSecret: false })}
            disabled={busy}
            className={local.segmented}
          />
        </div>
      </div>
      <p className={styles.hint}>{props.t(`form.login.hint.${draft.login}`)}</p>

      {draft.login === 'alias' ? (
        <>
          <TextField
            label={props.t('form.alias')}
            value={draft.alias}
            onChange={(alias) => patch({ alias })}
            placeholder={props.t('form.aliasPlaceholder')}
            addon={{
              label: props.t('form.pickHost'),
              onClick: () => setPickerOpen(true),
              disabled: busy,
            }}
            datalist={hosts.map((host) => ({ value: host.alias, label: sshHostMeta(host) }))}
          />
          {hint !== null ? <p className={styles.hint}>{hint}</p> : null}
        </>
      ) : (
        <>
          <div className={styles.grid}>
            <TextField
              label={props.t('form.host')}
              value={draft.host}
              onChange={(host) => patch({ host })}
              placeholder={props.t('form.hostPlaceholder')}
              autoFocus={props.mode === 'create'}
            />
            <div className={styles.inlineGrid}>
              <TextField
                label={props.t('form.port')}
                value={draft.port}
                onChange={(port) => patch({ port })}
                placeholder={props.t('form.portPlaceholder')}
                inputMode="numeric"
              />
              <TextField
                label={props.t('form.user')}
                value={draft.user}
                onChange={(user) => patch({ user })}
                placeholder={props.t('form.userPlaceholder')}
              />
            </div>
          </div>

          {draft.login === 'key' ? (
            <>
              <TextField
                label={props.t('form.identityFile')}
                value={draft.identityFile}
                onChange={(identityFile) => patch({ identityFile })}
                placeholder={props.t('form.identityFilePlaceholder')}
              />
              <p className={styles.hint}>{props.t('form.identityFileHint')}</p>
            </>
          ) : null}

          <SettingsSecretField
            id={secretId}
            label={draft.login === 'key' ? props.t('form.secretPassphrase') : props.t('form.secretPassword')}
            hint={props.t(reusableSecretOf(props.row, draft) ? 'form.secretHintReuse' : 'form.secretHint')}
            text={draft.secret}
            disabled={busy}
            onEdit={(secret) => patch({ secret, clearSecret: false })}
            configured={reusableSecretOf(props.row, draft)}
            stateLabel={
              reusableSecretOf(props.row, draft)
                ? props.row?.secretState === 'session'
                  ? props.t('form.secretSession')
                  : props.t('form.secretSaved')
                : props.t('form.secretNone')
            }
          />

          <div className={styles.secretTools}>
            <Checkbox
              checked={draft.rememberSecret}
              onChange={(rememberSecret) => patch({ rememberSecret })}
              label={props.t('form.rememberSecret')}
              disabled={busy}
            />
            {reusableSecretOf(props.row, draft) ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => patch({ secret: '', clearSecret: true })}
              >
                {props.t('form.clearSecret')}
              </Button>
            ) : null}
          </div>
        </>
      )}

      {touched && labelIssues.length + issues.length > 0 ? (
        <IssueList issues={[...labelIssues, ...issues].map((message) => ({ message }))} />
      ) : null}
      {routerError !== null ? (
        <div className={styles.error} role="alert">
          {routerError}
        </div>
      ) : null}

      <div className={styles.formActions}>
        <Button variant="outline" disabled={busy} onClick={test}>
          {state.testing ? props.t('form.testing') : props.t('form.test')}
        </Button>
        <div className={styles.formActionsRight}>
          <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
            {props.t('cancel')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {props.busy ? props.t('form.saving') : props.t('save')}
          </Button>
        </div>
      </div>

      {pickerOpen ? (
        <Dialog
          title={props.t('hostPicker.title')}
          description={
            state.sshHosts !== null
              ? props.t('hostPicker.description', { path: state.sshHosts.path })
              : undefined
          }
          closeLabel={props.t('close')}
          onClose={() => setPickerOpen(false)}
          actions={
            <Button variant="outline" onClick={() => setPickerOpen(false)}>
              {props.t('close')}
            </Button>
          }
        >
          <div className={local.pickerBody}>
            <SearchBox value={query} onChange={setQuery} label={props.t('hostPicker.search')} />
            {state.sshHostsError !== null ? (
              <div className={styles.error} role="alert">
                {props.t('hostPicker.error', {
                  detail: messageText(state.sshHostsError, props.t),
                })}
              </div>
            ) : null}
            {state.sshHostsLoading ? (
              <p className={styles.hint}>{props.t('hostPicker.loading')}</p>
            ) : pickerRows().length === 0 ? (
              <p className={styles.hint}>{props.t('hostPicker.empty')}</p>
            ) : (
              <ul className={local.hostList}>
                {pickerRows().map((host) => (
                  <li key={host.alias} className={local.hostItem}>
                    <button
                      type="button"
                      className={local.hostPick}
                      onClick={() => {
                        patch({ alias: host.alias, login: 'alias' })
                        setPickerOpen(false)
                      }}
                    >
                      {host.alias}
                    </button>
                    <span className={local.hostMeta}>{sshHostMeta(host)}</span>
                    {host.identityFile !== null ? (
                      <code className={local.hostNote}>{host.identityFile}</code>
                    ) : null}
                    {host.proxy !== null ? <code className={local.hostNote}>{host.proxy}</code> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}
