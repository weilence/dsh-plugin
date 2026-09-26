/**
 * MCP 服务器编辑弹窗（新建 / 编辑 / 查看三态）。
 *
 * - 新建：选目标层（profile / home）+ 传输形态，按形态给字段；serverName
 *   即模型侧工具名前缀，创建后 patch 行 id 固定为 mcp-<serverName>；
 * - 编辑：从行快照回填，未知键（reconnect 等）host 侧原样保留；
 * - 查看：只读展示生效配置、运行态与已注册工具清单（只读来源也走此视图）。
 *
 * args / env / headers 用等宽 textarea 逐行编辑（args 一行一个、env 与
 * headers 为 KEY=VALUE），保存前客户端做前置校验，最终以 host 侧为准。
 */

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { IssueList, PickList, SelectField, TextAreaField, TextField, type PickItem } from '@dsh-plugins/client-ui'
import type { McpRow, McpScope, McpTransport, SaveRequest } from '../shared'
import { SERVER_NAME_PATTERN } from '../shared'
import { endpointOf, parseMcpJsonText, type McpJsonParseResult } from '../mcpConfig'
import type { McpStore } from './store'
import shared from '@dsh-plugins/client-ui/styles'
import local from './McpSection.module.css'

const styles = { ...shared, ...local }

export interface McpEditorProps {
  mode: 'create' | 'edit' | 'view'
  row?: McpRow
  store: McpStore
  busy: boolean
  error: string | null
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

export function McpEditor(props: McpEditorProps) {
  const { mode, row, store } = props
  const [draft, setDraft] = useState<DraftState>(() => initialDraft(props))
  const [touched, setTouched] = useState(false)

  // 新建模式的两种输入：结构化表单 / 粘贴 JSON（mcpServers 包装、
  // 名称直接映射与裸对象三种写法，名称一律来自 JSON）。编辑与查看
  // 只有表单 / 只读视图。
  const [inputMode, setInputMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [parsed, setParsed] = useState<McpJsonParseResult | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [jsonError, setJsonError] = useState<string | null>(null)

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

  const parseJson = (): void => {
    setJsonError(null)
    setParsed(null)
    try {
      const result = parseMcpJsonText(jsonText)
      setParsed(result)
      setPicked(new Set(result.entries.map((entry) => entry.serverName)))
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error))
    }
  }

  const togglePick = (name: string): void => {
    setPicked((previous) => {
      const next = new Set(previous)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const importSelected = async (): Promise<void> => {
    if (parsed === null) return
    for (const entry of parsed.entries.filter((candidate) => picked.has(candidate.serverName))) {
      const ok = await store.save({
        scope: draft.scope,
        config: entry.draft,
        ...(Object.keys(entry.extras).length > 0 ? { extra: entry.extras } : {}),
      })
      if (!ok) return
    }
    props.onCancel()
  }

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (issues.length > 0) return
    const transport = draft.transport
    const request: SaveRequest = {
      scope: mode === 'create' ? draft.scope : (row?.scope as McpScope),
      ...(mode === 'edit' && row !== undefined ? { id: row.id } : {}),
      config: {
        transport,
        serverName: draft.serverName.trim(),
        ...(transport === 'stdio'
          ? {
              command: draft.command.trim(),
              ...(draft.args.trim().length > 0
                ? {
                    args: draft.args
                      .split(/\r?\n/)
                      .map((line) => line.trim())
                      .filter((line) => line.length > 0),
                  }
                : {}),
              ...(parseEntries(draft.env, '=') !== undefined ? { env: parseEntries(draft.env, '=') } : {}),
              ...(draft.cwd.trim().length > 0 ? { cwd: draft.cwd.trim() } : {}),
            }
          : {
              url: draft.url.trim(),
              ...(parseEntries(draft.headers, '=') !== undefined
                ? { headers: parseEntries(draft.headers, '=') }
                : {}),
            }),
        ...(draft.toolCallTimeoutMs.trim().length > 0
          ? { toolCallTimeoutMs: Number(draft.toolCallTimeoutMs) }
          : {}),
        failOnStartupError: draft.failOnStartupError,
      },
    }
    if (await store.save(request)) props.onCancel()
  }

  const title =
    mode === 'create'
      ? '新建 MCP 服务器'
      : mode === 'edit'
        ? `编辑 ${row?.config.serverName ?? ''}`
        : `查看 ${row?.config.serverName ?? row?.id ?? ''}`

  return (
    <Modal
      open
      onClose={() => {
        if (!props.busy) props.onCancel()
      }}
      title={title}
      closeLabel="关闭"
      className={styles.dialog}
      contentClassName={styles.scrollBody}
      footer={
        <>
          <span className={styles.footerMeta}>
            {mode === 'view' ? `patch id：${row?.id ?? ''}` : targetHint(draft, mode, row)}
          </span>
          {mode !== 'view' ? (
            <>
              <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
                取消
              </Button>
              {mode === 'create' && inputMode === 'json' ? (
                <Button
                  variant="primary"
                  disabled={props.busy || parsed === null || picked.size === 0}
                  onClick={() => void importSelected()}
                >
                  {props.busy ? '导入中…' : `导入选中（${picked.size}）`}
                </Button>
              ) : (
                <Button variant="primary" disabled={busy} onClick={() => void submit()}>
                  {props.busy ? '保存中…' : '保存'}
                </Button>
              )}
            </>
          ) : null}
        </>
      }
    >
      {mode === 'view' ? (
        <ViewBody row={row} />
      ) : (
        <>
          {mode === 'create' ? (
            <div className={styles.tabRow}>
              <Button
                size="sm"
                variant={inputMode === 'form' ? 'primary' : 'outline'}
                onClick={() => setInputMode('form')}
              >
                表单输入
              </Button>
              <Button
                size="sm"
                variant={inputMode === 'json' ? 'primary' : 'outline'}
                onClick={() => setInputMode('json')}
              >
                JSON 粘贴
              </Button>
            </div>
          ) : null}
          {mode === 'create' && inputMode === 'json' ? (
            <JsonBody
              jsonText={jsonText}
              onText={setJsonText}
              onParse={parseJson}
              parsed={parsed}
              picked={picked}
              onTogglePick={togglePick}
              scope={draft.scope}
              onScope={(scope) => setDraft((previous) => ({ ...previous, scope }))}
              jsonError={jsonError}
              busy={props.busy}
            />
          ) : (
            <EditBody
              draft={draft}
              setDraft={setDraft}
              mode={mode}
              issues={issues}
              touched={touched}
              error={props.error}
            />
          )}
        </>
      )}
    </Modal>
  )
}

function ViewBody(props: { row: McpRow | undefined }) {
  const { row } = props
  const configText = useMemo(() => JSON.stringify(row?.config ?? {}, null, 2), [row])
  return (
    <div className={styles.section}>
      <div className={styles.metaGrid}>
        <MetaItem label="serverName" value={row?.config.serverName} />
        <MetaItem
          label="传输"
          value={
            row?.config.transport === 'stdio'
              ? 'stdio'
              : row?.config.transport === 'streamable-http'
                ? 'streamable-http'
                : '—'
          }
        />
        <MetaItem label="端点" value={row ? endpointText(row) : undefined} wide />
        <MetaItem label="运行态" value={row?.live ? liveText(row) : '待生效（尚未挂载）'} />
        <MetaItem label="工具数" value={row?.live ? String(row.live.tools.length) : '—'} />
      </div>
      {row?.live?.error !== undefined ? (
        <div className={styles.error} role="alert">
          {row.live.error}
        </div>
      ) : null}
      {row?.live && row.live.tools.length > 0 ? (
        <div className={styles.bodyField}>
          <span className={styles.label}>已注册工具</span>
          <ul className={styles.toolList}>
            {row.live.tools.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className={styles.bodyField}>
        <span className={styles.label}>生效配置（JSON）</span>
        <textarea className={styles.rawView} readOnly value={configText} spellCheck={false} />
      </div>
    </div>
  )
}

/** 新建模式的 JSON 粘贴页：解析三种方言 → 勾选导入。 */
function JsonBody(props: {
  jsonText: string
  onText(text: string): void
  onParse(): void
  parsed: McpJsonParseResult | null
  picked: ReadonlySet<string>
  onTogglePick(name: string): void
  scope: McpScope
  onScope(scope: McpScope): void
  jsonError: string | null
  busy: boolean
}) {
  const { parsed } = props
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
      <div className={styles.parseRow}>
        <Button
          variant="outline"
          size="sm"
          disabled={props.busy || props.jsonText.trim().length === 0}
          onClick={props.onParse}
        >
          解析
        </Button>
      </div>
      {props.jsonError ? (
        <div className={styles.error} role="alert">
          {props.jsonError}
        </div>
      ) : null}
      <PickList items={pickItemsOf(parsed)} picked={props.picked} onToggle={props.onTogglePick} />
      {parsed !== null && parsed.problems.length > 0 ? (
        <IssueList
          issues={parsed.problems.map((problem) => ({
            message: `${problem.name.length > 0 ? problem.name : '（未命名）'}：${problem.message}`,
          }))}
        />
      ) : null}
      <p className={styles.hint}>
        {
          '兼容 Agent Plugins mcp.json 与 Claude .mcp.json 的 mcpServers 格式；{"名称": {...}} 直接映射同样支持，'
        }
        裸对象自动从 command / URL 推导名称；http / sse 归一为 streamable-http；表单外的未知键（reconnect
        等）原样透传，由 Loader 加载时校验；{'${PLUGIN_ROOT}'} 类占位符 DSH 无法解析，会直接报错。
      </p>
    </div>
  )
}

/** 解析结果 → 勾选清单行。 */
function pickItemsOf(parsed: McpJsonParseResult | null): PickItem[] {
  return (parsed?.entries ?? []).map((entry) => ({
    key: entry.serverName,
    title: entry.serverName,
    lines: [
      `${entry.draft.transport} · ${endpointOf({ ...entry.draft }) || '（缺端点）'}`,
      ...(Object.keys(entry.extras).length > 0 ? [`透传高级键：${Object.keys(entry.extras).join(', ')}`] : []),
    ],
    notes: entry.notes,
  }))
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
      {props.mode === 'create' ? (
        <div className={styles.grid}>
          <SelectField
            label="目标层"
            value={draft.scope}
            options={[
              { value: 'profile', label: 'Profile 层（仅当前 profile）' },
              { value: 'home', label: '全局层（~/.dsh，所有 profile）' },
            ]}
            onChange={(scope) => patch({ scope: scope as McpScope })}
          />
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
      ) : (
        <div className={styles.grid}>
          <TextField
            label="传输（编辑时不可改）"
            value={TRANSPORT_LABELS[draft.transport]}
            disabled
            onChange={() => {}}
          />
          <div className={styles.fieldWide}>
            <span className={styles.label}>目标</span>
            <span className={styles.hintLine}>{targetHint(draft, props.mode, undefined)}</span>
          </div>
        </div>
      )}
      <div className={styles.grid}>
        <TextField
          label="serverName（工具名前缀）"
          value={draft.serverName}
          placeholder="context7"
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
      <p className={styles.hint}>
        高级键（reconnect / maxInstructionBytes 等）不在表单内：编辑时原样保留，可手动改 patch 文件。
        serverName 决定模型看到的工具名前缀 mcp__&lt;serverName&gt;__*，全局唯一。
      </p>
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

function MetaItem(props: { label: string; value: string | undefined; wide?: boolean }) {
  return (
    <div className={props.wide ? styles.metaWide : styles.meta}>
      <span className={styles.label}>{props.label}</span>
      <span className={styles.metaValue}>{props.value ?? '—'}</span>
    </div>
  )
}

function endpointText(row: McpRow): string {
  const config = row.config
  if (config.transport === 'stdio') {
    const args = Array.isArray(config.args)
      ? (config.args as unknown[]).filter((part) => typeof part === 'string')
      : []
    return [typeof config.command === 'string' ? config.command : '', ...args]
      .filter((part) => part.length > 0)
      .join(' ')
  }
  return typeof config.url === 'string' ? config.url : '—'
}

function liveText(row: McpRow): string {
  if (row.live === null) return '待生效'
  const labels: Record<string, string> = {
    pending: '等待依赖',
    loading: '连接中',
    active: '运行中',
    failed: '失败',
    disposed: '已卸载',
    unloading: '卸载中',
  }
  return labels[row.live.status] ?? row.live.status
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

function initialDraft(props: McpEditorProps): DraftState {
  const config = props.row?.config ?? {}
  const entriesText = (value: unknown): string =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([key, val]) => `${key}=${val}`)
          .join('\n')
      : ''
  return {
    scope: props.mode === 'create' ? 'profile' : ((props.row?.scope as McpScope) ?? 'profile'),
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

function validateDraft(
  draft: DraftState,
  mode: 'create' | 'edit' | 'view',
  knownServerNames: Set<string>,
): string[] {
  if (mode === 'view') return []
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

function targetHint(draft: DraftState, mode: 'create' | 'edit' | 'view', row: McpRow | undefined): string {
  if (mode === 'edit' && row !== undefined)
    return `patch id ${row.id} · ${row.scope === 'home' ? '全局层' : 'Profile 层'}`
  return `将写入${draft.scope === 'home' ? '全局层' : 'Profile 层'}，行 id mcp-${draft.serverName.trim() || '<serverName>'}`
}
