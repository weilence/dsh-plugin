/**
 * 设置页「MCP 管理」面板：服务器声明列表（两层可编辑 patch + bundle /
 * overlay 只读来源）与运行态徽标，新建 / 编辑 / 查看 / 启停 / 删除弹窗。
 * 数据经 McpStore 与 host 桥交互；面板卸载时清一次性提示（Toast 计时
 * 只在挂载期间有效）。
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ConfirmDialog, ToneChip } from '@dsh-plugins/client-ui'
import type { McpRow } from '../shared'
import { SCOPE_LABELS } from '../shared'
import { endpointOf, transportOf } from '../mcpConfig'
import type { McpStore } from './store'
import { McpEditor } from './McpEditor'
import shared from '@dsh-plugins/client-ui/styles'
import local from './McpSection.module.css'

const styles = { ...shared, ...local }

/** 面板注入面（client.tsx 装配，槽位 inject 回调提供）。 */
export interface McpPanelEnv {
  store: McpStore
}

export function McpSection(props: McpPanelEnv & SettingsSectionOwnerProps) {
  return <McpPanel {...props} env={props} />
}

function McpPanel(props: SettingsSectionOwnerProps & { env: McpPanelEnv }) {
  const store = props.env.store
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    if (state.status === 'idle') void store.refresh()
  }, [store, state.status])
  useEffect(() => () => store.dismissNotice(), [store])

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<McpRow | undefined>(undefined)
  const [viewing, setViewing] = useState<McpRow | undefined>(undefined)
  const [deleting, setDeleting] = useState<McpRow | undefined>(undefined)

  const servers = state.list?.servers ?? []
  const busy = state.busy !== null

  return (
    <div className={styles.panel}>
      <header className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h2 className={styles.panelTitle}>MCP 管理</h2>
          <p className={styles.panelSubtitle}>
            以官方 mcp-client 组合行为唯一事实源：浏览当前 profile 的 MCP 服务器与运行态，对 profile 层 /
            全局层的新建、编辑、启停、删除（bundle 与运行时覆盖来源只读）。
          </p>
        </div>
      </header>

      {state.list !== null ? (
        <div className={styles.scopeBar}>
          <span className={styles.scopePath} title={state.list.patchPaths.profile}>
            Profile 层：{state.list.patchPaths.profile}
          </span>
          <span className={styles.scopePath} title={state.list.patchPaths.home}>
            全局层：{state.list.patchPaths.home}
          </span>
        </div>
      ) : null}
      <p className={styles.hint}>
        {state.list?.hotApply
          ? '保存 / 启停 / 删除写入 patch 文件后由 HMR 在线应用：新服务器的工具即刻注册，运行中的会话下一个回复即可调用；停用或删除同理即时卸载。'
          : '当前宿主未启用 HMR：写入只落盘，重启应用后生效（刷新按钮可重读文件与运行态）。'}
      </p>

      {state.error ? (
        <div className={styles.error} role="alert">
          {state.error}
        </div>
      ) : null}
      {state.notice !== null ? (
        <Toast key={state.notice} text={state.notice} holdMs={5000} onDone={() => store.dismissNotice()} />
      ) : null}
      <div className={styles.listToolbar}>
        <Button variant="primary" disabled={state.status !== 'ready'} onClick={() => setCreating(true)}>
          新建服务器
        </Button>
        <Button
          variant="outline"
          disabled={state.status === 'loading'}
          onClick={() => void store.refresh()}
        >
          刷新
        </Button>
      </div>
      {state.status === 'loading' ? <div className={styles.loading}>正在读取 MCP 服务器目录…</div> : null}

      <div className={styles.rows}>
        {servers.map((row) => (
          <McpCard
            key={`${row.scope}:${row.id}`}
            row={row}
            busy={busy || state.busy === row.id}
            onView={() => setViewing(row)}
            onEdit={() => setEditing(row)}
            onToggle={() =>
              void store.setEnabled({
                scope: row.scope as 'profile' | 'home',
                id: row.id,
                enabled: row.disabled,
              })
            }
            onDelete={() => setDeleting(row)}
          />
        ))}
        {servers.length === 0 && state.status === 'ready' ? (
          <div className={styles.empty}>
            还没有 MCP 服务器。stdio（本地命令）或 streamable-http（远程端点）都支持，点「新建服务器」开始。
          </div>
        ) : null}
      </div>

      {creating ? (
        <McpEditor
          mode="create"
          store={store}
          busy={busy}
          error={state.error}
          onCancel={() => setCreating(false)}
        />
      ) : null}
      {editing !== undefined ? (
        <McpEditor
          mode="edit"
          row={editing}
          store={store}
          busy={busy}
          error={state.error}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
      {viewing !== undefined ? (
        <McpEditor
          mode="view"
          row={viewing}
          store={store}
          busy={busy}
          error={state.error}
          onCancel={() => setViewing(undefined)}
        />
      ) : null}

      {deleting !== undefined ? (
        <ConfirmDialog
          title={`删除服务器 ${deleting.config.serverName ?? deleting.id}`}
          body={`将删除 ${SCOPE_LABELS[deleting.scope]}里的声明（id ${deleting.id}），HMR 会随即卸载其工具；不影响其他服务器。`}
          confirmLabel="删除"
          busy={busy}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const target = deleting
            setDeleting(undefined)
            void store.remove(
              { scope: target.scope as 'profile' | 'home', id: target.id },
              target.config.serverName ?? target.id,
            )
          }}
        />
      ) : null}
    </div>
  )
}

function statusBadge(row: McpRow): { text: string; kind: 'on' | 'off' | 'err' | 'warn'; title?: string } {
  if (row.disabled) return { text: '已停用', kind: 'off' }
  if (row.live === null) return { text: '待生效', kind: 'off' }
  switch (row.live.status) {
    case 'active':
      return { text: `运行中 · ${row.live.tools.length} 工具`, kind: 'on' }
    case 'loading':
    case 'pending':
      return { text: '连接中…', kind: 'warn' }
    case 'failed':
      return { text: '连接失败', kind: 'err', title: row.live.error }
    case 'disposed':
    case 'unloading':
      return { text: '已卸载', kind: 'off' }
    case 'absent':
      return { text: '已声明未挂载', kind: 'off' }
  }
}

function McpCard(props: {
  row: McpRow
  busy: boolean
  onView(): void
  onEdit(): void
  onToggle(): void
  onDelete(): void
}) {
  const { row } = props
  const badge = statusBadge(row)
  const editable = row.editable && (row.scope === 'profile' || row.scope === 'home')
  const serverName = row.config.serverName ?? '（未命名）'
  return (
    <section className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitleLine}>
          <span className={styles.rowName}>{serverName}</span>
          <span className={styles.rowSource}>{SCOPE_LABELS[row.scope]}</span>
          {transportOf(row.config) !== undefined ? (
            <span className={styles.rowSource}>{transportOf(row.config) === 'stdio' ? 'stdio' : 'HTTP'}</span>
          ) : null}
          {badge.kind === 'on' ? (
            <span className={styles.rowFlagOn}>{badge.text}</span>
          ) : badge.kind === 'err' ? (
            <span className={styles.rowFlagErr} title={badge.title ?? ''}>
              {badge.text}
            </span>
          ) : (
            <span className={styles.rowFlagOff}>{badge.text}</span>
          )}
        </div>
        <p className={styles.rowDesc}>{endpointOf(row.config) || '（缺少端点信息）'}</p>
        {row.live?.error !== undefined ? (
          <p className={styles.rowErrText} title={row.live.error}>
            {row.live.error}
          </p>
        ) : null}
        <p className={styles.rowPath}>patch id：{row.id}</p>
      </div>
      <div className={styles.rowActions}>
        <ToneChip tone={editable ? 'ok' : 'warn'}>{editable ? '可编辑' : '只读'}</ToneChip>
        <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onView}>
          查看
        </Button>
        {editable ? (
          <>
            <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onEdit}>
              编辑
            </Button>
            <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onToggle}>
              {row.disabled ? '启用' : '停用'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.dangerGhost}
              disabled={props.busy}
              onClick={props.onDelete}
            >
              删除
            </Button>
          </>
        ) : null}
      </div>
    </section>
  )
}
