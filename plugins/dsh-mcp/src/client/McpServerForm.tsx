import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { IssueList, MetaItem, SelectField, TextAreaField, TextField } from '@dsh-plugins/client-ui'
import type {
  McpConfigDraft,
  McpEffectiveConfig,
  McpLiveState,
  McpRow,
  McpScope,
  McpTransport,
  SaveRequest,
} from '../shared'
import { errMsg } from '@dsh-plugins/shared'
import { SERVER_NAME_PATTERN } from '../shared'
import { ConfigError, endpointOf, parseMcpJsonText, type McpJsonParseResult } from '../mcpConfig'
import { messageText, type McpT } from './locales'
import type { McpStore } from './store'
import { mcpApi } from './api'
import shared from '@dsh-plugins/client-ui/styles'
import local from './McpSection.module.css'

const styles = { ...shared, ...local }

export interface McpServerFormProps {
  mode: 'create' | 'edit'
  row?: McpRow
  store: McpStore
  t: McpT
  busy: boolean
  error: string | null
  /** 保存成功后回调（父级收起卡片）。 */
  onDone(): void
  /** 取消编辑（父级收起卡片，未保存的草稿丢弃）。 */
  onCancel(): void
}

interface DraftState {
  scope: McpScope
  transport: McpTransport
  serverName: string
  command: string
  args: string
  env: string
  cwd: string
  url: string
  headers: string
  toolCallTimeoutMs: string
  failOnStartupError: boolean
}

export function McpServerForm(props: McpServerFormProps) {
  const { mode, row, store, t } = props
  const [draft, setDraft] = useState<DraftState>(() => initialDraft(props))
  const [touched, setTouched] = useState(false)

  // 两种输入视图共享同一份草稿：新建的 JSON 粘贴在保存时整批解析落盘
  // （jsonText），编辑的 JSON 直接回填草稿（jsonEdited）。
  const [inputMode, setInputMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [jsonEdited, setJsonEdited] = useState<string | null>(null)
  const [jsonEditError, setJsonEditError] = useState<string | null>(null)
  // 保存动作的结论（解析问题 / 连接检查失败）；checkBypassed 标记「上次
  // 检查失败后用户再次点击」，此时跳过检查直接写入。
  const [actionError, setActionError] = useState<string | null>(null)
  const [checkBypassed, setCheckBypassed] = useState(false)
  const [checking, setChecking] = useState(false)

  const knownServerNames = useMemo(
    () =>
      new Set(
        (store.getSnapshot().list?.servers ?? [])
          .filter((candidate) => candidate.config.serverName !== undefined && candidate.id !== row?.id)
          .map((candidate) => candidate.config.serverName as string),
      ),
    [store, row],
  )

  const issues = validateDraft(draft, mode, knownServerNames, t)
  const busy = props.busy

  const switchInputMode = (next: 'form' | 'json'): void => {
    setInputMode(next)
    // 进入编辑的 JSON 视图时以当前草稿为准重新生成文本（表单侧的修改不丢）。
    if (mode === 'edit' && next === 'json') {
      setJsonEdited(jsonTextOf(draft))
      setJsonEditError(null)
    }
  }

  /** 任何输入变动都让上一次检查结论失效，保存按钮回到「先检查」语义。 */
  const clearOutcome = (): void => {
    setActionError(null)
    setCheckBypassed(false)
  }

  const updateDraft: Dispatch<SetStateAction<DraftState>> = (action) => {
    clearOutcome()
    setDraft(action)
  }

  /** JSON 解析错误 → 展示文本：client 侧 ConfigError 带词典描述子，其余按
   *  errMsg 原样展示。 */
  const parseErrorText = (error: unknown): string =>
    error instanceof ConfigError && error.descriptor !== undefined
      ? messageText(error.descriptor, t)
      : errMsg(error)

  /** 编辑的 JSON 文本回填：解析成功即应用到草稿；serverName 由外层键给出，
   *  回填时以当前行为准（名称改动 = 删除后新建，不走编辑）。 */
  const applyJsonEdit = (text: string): void => {
    clearOutcome()
    setJsonEdited(text)
    setJsonEditError(null)
    if (text.trim().length === 0) return
    try {
      const result = parseMcpJsonText(text)
      if (result.entries.length !== 1) {
        setJsonEditError(t('input.needSingleEntry'))
        return
      }
      setDraft((previous) => ({
        ...draftFromConfig(result.entries[0].draft, previous.scope),
        serverName: previous.serverName,
      }))
    } catch (error) {
      setJsonEditError(parseErrorText(error))
    }
  }

  /** 保存前的连接检查：逐台做 initialize 握手探测；上次失败后本次点击即显式跳过。 */
  const runCheck = async (targets: { name: string; config: McpConfigDraft }[]): Promise<boolean> => {
    if (checkBypassed) return true
    setChecking(true)
    try {
      for (const target of targets) {
        const outcome = await mcpApi.check({ config: target.config })
        if (!outcome.ok) {
          setActionError(
            t('check.failed', { name: target.name, reason: outcome.error ?? t('check.unknownReason') }),
          )
          setCheckBypassed(true)
          return false
        }
      }
      return true
    } catch (error) {
      setActionError(t('check.requestFailed', { detail: errMsg(error) }))
      return false
    } finally {
      setChecking(false)
    }
  }

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (issues.length > 0) return
    const config = configOf(draft)
    if (!(await runCheck([{ name: config.serverName, config }]))) return
    const request: SaveRequest = {
      scope: mode === 'create' ? draft.scope : (row?.scope as McpScope),
      id: mode === 'edit' ? row?.id : undefined,
      config,
    }
    if (await store.save(request)) props.onDone()
  }

  /** 新建 JSON 粘贴的保存：解析 → 本地预检（问题 / 重名）→ 逐台连接检查 → 整批落盘。 */
  const submitJson = async (): Promise<void> => {
    let result: McpJsonParseResult
    try {
      result = parseMcpJsonText(jsonText)
    } catch (error) {
      setActionError(parseErrorText(error))
      return
    }
    if (result.problems.length > 0) {
      setActionError(
        result.problems
          .map((problem) =>
            t('import.problemLine', {
              name: problem.name.length > 0 ? problem.name : t('row.unnamed'),
              message: messageText(problem.message, t),
            }),
          )
          .join(t('import.problemJoin')),
      )
      return
    }
    const seen = new Set(knownServerNames)
    for (const entry of result.entries) {
      if (seen.has(entry.serverName)) {
        setActionError(t('input.duplicateInBatch', { name: entry.serverName }))
        return
      }
      seen.add(entry.serverName)
    }
    if (!(await runCheck(result.entries.map((entry) => ({ name: entry.serverName, config: entry.draft })))))
      return
    for (const entry of result.entries) {
      const ok = await store.save({
        scope: draft.scope,
        config: entry.draft,
        extra: Object.keys(entry.extras).length > 0 ? entry.extras : undefined,
      })
      if (!ok) return
    }
    props.onDone()
  }

  return (
    <div className={styles.section}>
      <div className={styles.tabRow}>
        <Button
          size="sm"
          variant={inputMode === 'form' ? 'primary' : 'outline'}
          onClick={() => switchInputMode('form')}
        >
          {t('input.formTab')}
        </Button>
        <Button
          size="sm"
          variant={inputMode === 'json' ? 'primary' : 'outline'}
          onClick={() => switchInputMode('json')}
        >
          {mode === 'create' ? t('input.jsonPasteTab') : t('input.jsonEditTab')}
        </Button>
      </div>
      {mode === 'create' && inputMode === 'json' ? (
        <JsonBody
          t={t}
          jsonText={jsonText}
          onText={(text) => {
            clearOutcome()
            setJsonText(text)
          }}
          scope={draft.scope}
          onScope={(scope) => {
            clearOutcome()
            setDraft((previous) => ({ ...previous, scope }))
          }}
        />
      ) : inputMode === 'json' ? (
        <div className={styles.section}>
          <TextAreaField
            label={t('input.jsonEditLabel')}
            value={jsonEdited ?? jsonTextOf(draft)}
            spellCheck={false}
            minHeight={280}
            onChange={applyJsonEdit}
          />
          {jsonEditError !== null ? (
            <div className={styles.error} role="alert">
              {jsonEditError}
            </div>
          ) : null}
        </div>
      ) : (
        <EditBody
          t={t}
          draft={draft}
          setDraft={updateDraft}
          mode={mode}
          issues={issues}
          touched={touched}
          error={props.error}
        />
      )}
      {actionError !== null ? (
        <div className={styles.error} role="alert">
          {actionError}
        </div>
      ) : null}
      <div className={styles.formActions}>
        <Button variant="outline" disabled={busy || checking} onClick={props.onCancel}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={busy || checking}
          onClick={() => void (mode === 'create' && inputMode === 'json' ? submitJson() : submit())}
        >
          {checking ? t('action.checking') : busy ? t('action.saving') : t('save')}
        </Button>
      </div>
    </div>
  )
}

/** 只读详情（bundle / overlay 等不可编辑来源的展开体）。 */
export function McpServerView(props: { row: McpRow; t: McpT }) {
  const { row, t } = props
  const configText = useMemo(() => JSON.stringify(row.config ?? {}, null, 2), [row])
  return (
    <div className={styles.section}>
      <div className={styles.metaGrid}>
        <MetaItem label="serverName" value={row.config.serverName} />
        <MetaItem
          label={t('view.transport')}
          value={
            row.config.transport === 'stdio'
              ? 'stdio'
              : row.config.transport === 'streamable-http'
                ? 'streamable-http'
                : '—'
          }
        />
        <MetaItem label={t('view.endpoint')} value={endpointText(row)} wide />
        <MetaItem label={t('view.live')} value={row.live ? liveText(row, t) : t('view.livePending')} />
        <MetaItem label={t('view.toolCount')} value={row.live ? String(row.live.tools.length) : '—'} />
      </div>
      {row.live?.error !== undefined ? (
        <div className={styles.error} role="alert">
          {row.live.error}
        </div>
      ) : null}
      {row.live && row.live.tools.length > 0 ? (
        <div className={styles.bodyField}>
          <span className={styles.label}>{t('view.tools')}</span>
          <ul className={styles.toolList}>
            {row.live.tools.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <TextAreaField
        label={t('view.effectiveConfig')}
        value={configText}
        readOnly
        minHeight={200}
        spellCheck={false}
      />
    </div>
  )
}

/** 新建模式的 JSON 粘贴页：方言解析与写入都在「保存」时一次完成。 */
function JsonBody(props: {
  t: McpT
  jsonText: string
  onText(text: string): void
  scope: McpScope
  onScope(scope: McpScope): void
}) {
  const { t } = props
  return (
    <div className={styles.section}>
      <div className={styles.grid}>
        <SelectField
          label={t('input.scope')}
          value={props.scope}
          options={[
            { value: 'profile', label: t('input.scopeProfile') },
            { value: 'home', label: t('input.scopeHome') },
          ]}
          onChange={(scope) => props.onScope(scope as McpScope)}
        />
      </div>
      <TextAreaField
        label={t('input.jsonPasteLabel')}
        value={props.jsonText}
        placeholder={
          '{\n  "mcpServers": {\n    "context7": {\n      "type": "stdio",\n      "command": "npx",\n      "args": ["-y", "@upstash/context7-mcp"]\n    }\n  }\n}'
        }
        onChange={props.onText}
      />
    </div>
  )
}

function EditBody(props: {
  t: McpT
  draft: DraftState
  setDraft: Dispatch<SetStateAction<DraftState>>
  mode: 'create' | 'edit'
  issues: string[]
  touched: boolean
  error: string | null
}) {
  const { t, draft, setDraft } = props
  const patch = (partial: Partial<DraftState>): void => setDraft((previous) => ({ ...previous, ...partial }))
  return (
    <div className={styles.section}>
      <div className={styles.grid}>
        {props.mode === 'create' ? (
          <SelectField
            label={t('input.scope')}
            value={draft.scope}
            options={[
              { value: 'profile', label: t('input.scopeProfile') },
              { value: 'home', label: t('input.scopeHome') },
            ]}
            onChange={(scope) => patch({ scope: scope as McpScope })}
          />
        ) : null}
        <SelectField
          label={t('input.transport')}
          value={draft.transport}
          options={[
            { value: 'stdio', label: t('input.transportStdio') },
            { value: 'streamable-http', label: t('input.transportHttp') },
          ]}
          onChange={(transport) => patch({ transport: transport as McpTransport })}
        />
      </div>
      <div className={styles.grid}>
        <TextField
          label={t('input.serverName')}
          value={draft.serverName}
          placeholder="context7"
          autoFocus={props.mode === 'create'}
          onChange={(serverName) => patch({ serverName })}
        />
        {draft.transport === 'stdio' ? (
          <TextField
            label={t('input.command')}
            value={draft.command}
            placeholder="npx"
            onChange={(command) => patch({ command })}
          />
        ) : (
          <div className={styles.fieldWide}>
            <TextField
              label={t('input.url')}
              wide
              value={draft.url}
              placeholder="https://mcp.example.com/mcp"
              onChange={(url) => patch({ url })}
            />
          </div>
        )}
      </div>
      {draft.transport === 'stdio' ? (
        <>
          <TextAreaField
            label={t('input.args')}
            value={draft.args}
            placeholder={'-y\n@upstash/context7-mcp'}
            onChange={(args) => patch({ args })}
          />
          <TextAreaField
            label={t('input.env')}
            value={draft.env}
            placeholder={'API_KEY=...'}
            onChange={(env) => patch({ env })}
          />
          <TextField label={t('input.cwd')} value={draft.cwd} onChange={(cwd) => patch({ cwd })} />
        </>
      ) : (
        <TextAreaField
          label={t('input.headers')}
          value={draft.headers}
          placeholder={'Authorization=Bearer ...'}
          onChange={(headers) => patch({ headers })}
        />
      )}
      <div className={styles.grid}>
        <TextField
          label={t('input.timeout')}
          value={draft.toolCallTimeoutMs}
          inputMode="numeric"
          placeholder="60000"
          onChange={(toolCallTimeoutMs) => patch({ toolCallTimeoutMs })}
        />
        <div className={styles.fieldWide}>
          <label className={styles.check}>
            <Switch
              checked={draft.failOnStartupError}
              onChange={(checked) => patch({ failOnStartupError: checked })}
              label={t('input.failOnStartup')}
            />
            {t('input.failOnStartupHint')}
          </label>
        </div>
      </div>
      {props.touched && props.issues.length > 0 ? (
        <IssueList issues={props.issues.map((message) => ({ message }))} />
      ) : null}
      {props.error ? (
        <div className={styles.error} role="alert">
          {props.error}
        </div>
      ) : null}
    </div>
  )
}

function endpointText(row: McpRow): string {
  return endpointOf(row.config) || '—'
}

function liveText(row: McpRow, t: McpT): string {
  if (row.live === null) return t('row.pendingEffect')
  if (row.live.status === 'absent') return t('row.absent')
  const labels: Record<Exclude<McpLiveState['status'], 'absent'>, string> = {
    pending: t('view.livePendingDeps'),
    loading: t('view.liveConnecting'),
    active: t('view.liveActive'),
    failed: t('view.liveFailed'),
    disposed: t('row.unloaded'),
    unloading: t('view.liveUnloading'),
  }
  return labels[row.live.status]
}

/** KEY=VALUE 逐行解析；空行与 # 注释忽略；无有效行返回 undefined。 */
function parseEntries(text: string, separator: string): Record<string, string> | undefined {
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  const record: Record<string, string> = {}
  for (const line of entries) {
    const at = line.indexOf(separator)
    if (at <= 0) continue
    record[line.slice(0, at)] = line.slice(at + separator.length)
  }
  return Object.keys(record).length > 0 ? record : undefined
}

function entriesText(value: unknown): string {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, val]) => `${key}=${val}`)
        .join('\n')
    : ''
}

// 草稿 → 单服务器 config 对象（保存写入与 JSON 视图的序列化同源）；空输入
// 归 undefined，序列化即省略该键
function configOf(draft: DraftState): McpConfigDraft {
  const stdio = draft.transport === 'stdio'
  const args = draft.args
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return {
    transport: draft.transport,
    serverName: draft.serverName.trim(),
    command: stdio ? draft.command.trim() : undefined,
    args: stdio && args.length > 0 ? args : undefined,
    env: stdio ? parseEntries(draft.env, '=') : undefined,
    cwd: stdio && draft.cwd.trim().length > 0 ? draft.cwd.trim() : undefined,
    url: stdio ? undefined : draft.url.trim(),
    headers: stdio ? undefined : parseEntries(draft.headers, '='),
    toolCallTimeoutMs:
      draft.toolCallTimeoutMs.trim().length > 0 ? Number(draft.toolCallTimeoutMs) : undefined,
    failOnStartupError: draft.failOnStartupError,
  }
}

/** config 对象 → 草稿（JSON 视图回填；scope 由调用方给定）。 */
function draftFromConfig(config: McpConfigDraft | McpEffectiveConfig, scope: McpScope): DraftState {
  return {
    scope,
    transport: config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    serverName: typeof config.serverName === 'string' ? config.serverName : '',
    command: typeof config.command === 'string' ? config.command : '',
    args: Array.isArray(config.args)
      ? (config.args as unknown[]).filter((part) => typeof part === 'string').join('\n')
      : '',
    env: entriesText(config.env),
    cwd: typeof config.cwd === 'string' ? config.cwd : '',
    url: typeof config.url === 'string' ? config.url : '',
    headers: entriesText(config.headers),
    toolCallTimeoutMs: typeof config.toolCallTimeoutMs === 'number' ? String(config.toolCallTimeoutMs) : '',
    failOnStartupError: config.failOnStartupError === true,
  }
}

function initialDraft(props: McpServerFormProps): DraftState {
  const scope = props.mode === 'create' ? 'profile' : ((props.row?.scope as McpScope) ?? 'profile')
  return draftFromConfig(props.row?.config ?? {}, scope)
}

/** 编辑 JSON 视图的文本：外层键即 serverName，值为其 config。 */
function jsonTextOf(draft: DraftState): string {
  const { serverName, ...rest } = configOf(draft)
  return JSON.stringify({ [serverName]: rest }, null, 2)
}

function validateDraft(
  draft: DraftState,
  mode: 'create' | 'edit',
  knownServerNames: Set<string>,
  t: McpT,
): string[] {
  const issues: string[] = []
  if (!SERVER_NAME_PATTERN.test(draft.serverName.trim())) {
    issues.push(t('validate.serverName'))
  } else if (mode === 'create' && knownServerNames.has(draft.serverName.trim())) {
    issues.push(t('validate.duplicate', { name: draft.serverName.trim() }))
  }
  if (draft.transport === 'stdio') {
    if (draft.command.trim().length === 0) issues.push(t('validate.commandRequired'))
  } else if (draft.url.trim().length === 0) {
    issues.push(t('validate.urlRequired'))
  } else {
    try {
      const parsed = new URL(draft.url.trim())
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') issues.push(t('validate.urlProtocol'))
    } catch {
      issues.push(t('validate.urlInvalid'))
    }
  }
  if (draft.toolCallTimeoutMs.trim().length > 0) {
    const value = Number(draft.toolCallTimeoutMs)
    if (!Number.isFinite(value) || value <= 0) issues.push(t('validate.timeoutPositive'))
  }
  return issues
}
