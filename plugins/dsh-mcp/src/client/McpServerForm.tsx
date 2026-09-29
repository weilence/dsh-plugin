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
import { endpointOf, parseMcpJsonText, type McpJsonParseResult } from '../mcpConfig'
import type { McpStore } from './store'
import { mcpApi } from './api'
import shared from '@dsh-plugins/client-ui/styles'
import local from './McpSection.module.css'

const styles = { ...shared, ...local }

export interface McpServerFormProps {
  mode: 'create' | 'edit'
  row?: McpRow
  store: McpStore
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

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'stdio（本地命令子进程）',
  'streamable-http': 'streamable-http（HTTP 端点）',
}

export function McpServerForm(props: McpServerFormProps) {
  const { mode, row, store } = props
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

  const issues = validateDraft(draft, mode, knownServerNames)
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
        setJsonEditError('需要恰好一个服务器对象；多台批量导入请用「新建服务器」的 JSON 粘贴')
        return
      }
      setDraft((previous) => ({
        ...draftFromConfig(result.entries[0].draft, previous.scope),
        serverName: previous.serverName,
      }))
    } catch (error) {
      setJsonEditError(errMsg(error))
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
            `服务器「${target.name}」连接检查未通过：${outcome.error ?? '未知原因'}。修正后重试，或再点一次「保存」跳过检查直接写入。`,
          )
          setCheckBypassed(true)
          return false
        }
      }
      return true
    } catch (error) {
      setActionError(`连接检查请求失败：${errMsg(error)}`)
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
      setActionError(errMsg(error))
      return
    }
    if (result.problems.length > 0) {
      setActionError(
        result.problems
          .map((problem) => `${problem.name.length > 0 ? problem.name : '（未命名）'}：${problem.message}`)
          .join('；'),
      )
      return
    }
    const seen = new Set(knownServerNames)
    for (const entry of result.entries) {
      if (seen.has(entry.serverName)) {
        setActionError(`serverName「${entry.serverName}」已存在（或与本批重名）`)
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
          表单输入
        </Button>
        <Button
          size="sm"
          variant={inputMode === 'json' ? 'primary' : 'outline'}
          onClick={() => switchInputMode('json')}
        >
          {mode === 'create' ? 'JSON 粘贴' : 'JSON 编辑'}
        </Button>
      </div>
      {mode === 'create' && inputMode === 'json' ? (
        <JsonBody
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
            label="配置（外层键即 serverName，名称以当前行为准）"
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
          取消
        </Button>
        <Button
          variant="primary"
          disabled={busy || checking}
          onClick={() => void (mode === 'create' && inputMode === 'json' ? submitJson() : submit())}
        >
          {checking ? '检查中…' : busy ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}

/** 只读详情（bundle / overlay 等不可编辑来源的展开体）。 */
export function McpServerView(props: { row: McpRow }) {
  const { row } = props
  const configText = useMemo(() => JSON.stringify(row.config ?? {}, null, 2), [row])
  return (
    <div className={styles.section}>
      <div className={styles.metaGrid}>
        <MetaItem label="serverName" value={row.config.serverName} />
        <MetaItem
          label="传输"
          value={
            row.config.transport === 'stdio'
              ? 'stdio'
              : row.config.transport === 'streamable-http'
                ? 'streamable-http'
                : '—'
          }
        />
        <MetaItem label="端点" value={endpointText(row)} wide />
        <MetaItem label="运行态" value={row.live ? liveText(row) : '待生效（尚未挂载）'} />
        <MetaItem label="工具数" value={row.live ? String(row.live.tools.length) : '—'} />
      </div>
      {row.live?.error !== undefined ? (
        <div className={styles.error} role="alert">
          {row.live.error}
        </div>
      ) : null}
      {row.live && row.live.tools.length > 0 ? (
        <div className={styles.bodyField}>
          <span className={styles.label}>已注册工具</span>
          <ul className={styles.toolList}>
            {row.live.tools.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <TextAreaField
        label="生效配置（JSON）"
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
  jsonText: string
  onText(text: string): void
  scope: McpScope
  onScope(scope: McpScope): void
}) {
  return (
    <div className={styles.section}>
      <div className={styles.grid}>
        <SelectField
          label="目标层"
          value={props.scope}
          options={[
            { value: 'profile', label: 'Profile 层（仅当前 profile）' },
            { value: 'home', label: '全局层（~/.dsh，所有 profile）' },
          ]}
          onChange={(scope) => props.onScope(scope as McpScope)}
        />
      </div>
      <TextAreaField
        label={'粘贴 JSON（支持 {"mcpServers": {...}} 包装、{"名称": {...}} 直接映射与单个服务器对象）'}
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
  draft: DraftState
  setDraft: Dispatch<SetStateAction<DraftState>>
  mode: 'create' | 'edit'
  issues: string[]
  touched: boolean
  error: string | null
}) {
  const { draft, setDraft } = props
  const patch = (partial: Partial<DraftState>): void => setDraft((previous) => ({ ...previous, ...partial }))
  return (
    <div className={styles.section}>
      <div className={styles.grid}>
        {props.mode === 'create' ? (
          <SelectField
            label="目标层"
            value={draft.scope}
            options={[
              { value: 'profile', label: 'Profile 层（仅当前 profile）' },
              { value: 'home', label: '全局层（~/.dsh，所有 profile）' },
            ]}
            onChange={(scope) => patch({ scope: scope as McpScope })}
          />
        ) : null}
        <SelectField
          label="传输形态"
          value={draft.transport}
          options={[
            { value: 'stdio', label: TRANSPORT_LABELS.stdio },
            { value: 'streamable-http', label: TRANSPORT_LABELS['streamable-http'] },
          ]}
          onChange={(transport) => patch({ transport: transport as McpTransport })}
        />
      </div>
      <div className={styles.grid}>
        <TextField
          label="serverName（工具名前缀）"
          value={draft.serverName}
          placeholder="context7"
          autoFocus={props.mode === 'create'}
          onChange={(serverName) => patch({ serverName })}
        />
        {draft.transport === 'stdio' ? (
          <TextField
            label="command（可执行文件）"
            value={draft.command}
            placeholder="npx"
            onChange={(command) => patch({ command })}
          />
        ) : (
          <div className={styles.fieldWide}>
            <TextField
              label="url（MCP 端点）"
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
            label="args（每行一个，不经 shell 插值）"
            value={draft.args}
            placeholder={'-y\n@upstash/context7-mcp'}
            onChange={(args) => patch({ args })}
          />
          <TextAreaField
            label="env（每行 KEY=VALUE）"
            value={draft.env}
            placeholder={'API_KEY=...'}
            onChange={(env) => patch({ env })}
          />
          <TextField
            label="cwd（可选，子进程工作目录）"
            value={draft.cwd}
            onChange={(cwd) => patch({ cwd })}
          />
        </>
      ) : (
        <TextAreaField
          label="headers（每行 KEY=VALUE，如 Authorization=Bearer …）"
          value={draft.headers}
          placeholder={'Authorization=Bearer ...'}
          onChange={(headers) => patch({ headers })}
        />
      )}
      <div className={styles.grid}>
        <TextField
          label="调用超时 ms（可选，缺省 60000）"
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
              label="启动失败即报错"
            />
            初始连接失败时让插件行失败（阻止激活；缺省关闭并进入自动重连）
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

function liveText(row: McpRow): string {
  if (row.live === null) return '待生效'
  if (row.live.status === 'absent') return '已声明未挂载'
  const labels: Record<Exclude<McpLiveState['status'], 'absent'>, string> = {
    pending: '等待依赖',
    loading: '连接中',
    active: '运行中',
    failed: '失败',
    disposed: '已卸载',
    unloading: '卸载中',
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

function validateDraft(draft: DraftState, mode: 'create' | 'edit', knownServerNames: Set<string>): string[] {
  const issues: string[] = []
  if (!SERVER_NAME_PATTERN.test(draft.serverName.trim())) {
    issues.push('serverName 需匹配 ^[A-Za-z0-9_-]{1,32}$，如 context7')
  } else if (mode === 'create' && knownServerNames.has(draft.serverName.trim())) {
    issues.push(`serverName「${draft.serverName.trim()}」已存在`)
  }
  if (draft.transport === 'stdio') {
    if (draft.command.trim().length === 0) issues.push('stdio 传输需要 command')
  } else if (draft.url.trim().length === 0) {
    issues.push('streamable-http 传输需要 url')
  } else {
    try {
      const parsed = new URL(draft.url.trim())
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        issues.push('url 协议必须是 http 或 https')
    } catch {
      issues.push('url 不是合法的 URL')
    }
  }
  if (draft.toolCallTimeoutMs.trim().length > 0) {
    const value = Number(draft.toolCallTimeoutMs)
    if (!Number.isFinite(value) || value <= 0) issues.push('调用超时必须是正数（毫秒）')
  }
  return issues
}
