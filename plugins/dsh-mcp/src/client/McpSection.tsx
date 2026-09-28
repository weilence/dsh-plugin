/**
 * 设置页「MCP 管理」面板：服务器声明列表（两层可编辑 patch + bundle /
 * overlay 只读来源）与运行态徽标。列表为可展开卡片——点行展开即编辑 /
 * 查看，新建服务器卡片插入列表顶部（触发按钮正下方，长列表也不会被推到
 * 视口外）。数据经 McpStore 与 host 桥交互；面板卸载时清一次性提示
 * （Toast 计时只在挂载期间有效）。
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardList, ConfirmDialog, ExpandableCard, Panel } from '@dsh-plugins/client-ui'
import type { McpRow } from '../shared'
import { endpointOf, transportOf } from '../mcpConfig'
import type { McpStore } from './store'
import { McpServerForm, McpServerView } from './McpServerForm'
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
  /** 展开中的行（编辑 / 查看）；undefined = 全部收起。 */
  const [editingId, setEditingId] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState<McpRow | undefined>(undefined)

  const servers = state.list?.servers ?? []
  const busy = state.busy !== null
  const editing = editingId !== undefined ? servers.find((row) => row.id === editingId) : undefined

  const collapse = (): void => {
    setCreating(false)
    setEditingId(undefined)
  }

  return (
    <Panel title="MCP 管理">
      {state.error ? (
        <div className={styles.error} role="alert">
          {state.error}
        </div>
      ) : null}
      {state.notice !== null ? (
        <Toast key={state.notice} text={state.notice} holdMs={5000} onDone={() => store.dismissNotice()} />
      ) : null}
      <div className={styles.listToolbar}>
        <Button
          variant="primary"
          disabled={state.status !== 'ready'}
          onClick={() => {
            setEditingId(undefined)
            setCreating(!creating)
          }}
        >
          新建服务器
        </Button>
        <Button variant="outline" disabled={state.status === 'loading'} onClick={() => void store.refresh()}>
          刷新
        </Button>
      </div>
      {state.status === 'loading' ? <div className={styles.loading}>正在读取 MCP 服务器目录…</div> : null}

      <CardList
        items={servers}
        getKey={(row) => `${row.scope}:${row.id}`}
        before={
          // 新建卡片在列表顶部：触发按钮就在上方，长列表也不会把表单推到视口外。
          creating ? (
            <ExpandableCard
              title="新建服务器"
              open
              onToggle={() => {
                if (!busy) setCreating(false)
              }}
            >
              <McpServerForm
                mode="create"
                store={store}
                busy={busy}
                error={state.error}
                onDone={collapse}
                onCancel={collapse}
              />
            </ExpandableCard>
          ) : null
        }
        empty={
          state.status === 'ready' && !creating ? (
            <div className={styles.empty}>
              还没有 MCP 服务器。stdio（本地命令）或 streamable-http（远程端点）都支持，点「新建服务器」开始。
            </div>
          ) : null
        }
        renderCard={(row) => {
          const editable = row.editable && (row.scope === 'profile' || row.scope === 'home')
          const badge = statusBadge(row)
          const expanded = editingId === row.id
          const transport = transportOf(row.config)
          return {
            title: row.config.serverName ?? '（未命名）',
            pills: [
              ...(transport !== undefined ? [{ text: transport === 'stdio' ? 'stdio' : 'HTTP' }] : []),
              { text: editable ? '可编辑' : '只读', tone: editable ? 'ok' : 'warn' },
              {
                text: badge.text,
                tone: badge.kind === 'on' ? 'ok' : badge.kind === 'err' ? 'err' : 'neutral',
                title: badge.title,
              },
            ],
            description: endpointOf(row.config) || '（缺少端点信息）',
            error: row.live?.error,
            open: expanded,
            onToggle: () => {
              if (busy) return
              setCreating(false)
              setEditingId(expanded ? undefined : row.id)
            },
            actions: editable ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void store.setEnabled({
                      scope: row.scope as 'profile' | 'home',
                      id: row.id,
                      enabled: row.disabled,
                    })
                  }
                >
                  {row.disabled ? '启用' : '停用'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.dangerGhost}
                  disabled={busy}
                  onClick={() => setDeleting(row)}
                >
                  删除
                </Button>
              </>
            ) : null,
            children: expanded ? (
              editable && editing !== undefined ? (
                <McpServerForm
                  mode="edit"
                  row={editing}
                  store={store}
                  busy={busy}
                  error={state.error}
                  onDone={collapse}
                  onCancel={collapse}
                />
              ) : (
                <McpServerView row={row} />
              )
            ) : null,
          }
        }}
      />

      {deleting !== undefined ? (
        <ConfirmDialog
          title={`删除服务器 ${deleting.config.serverName ?? deleting.id}`}
          body={`将删除这条声明（id ${deleting.id}），HMR 会随即卸载其工具；不影响其他服务器。`}
          confirmLabel="删除"
          busy={busy}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const target = deleting
            setDeleting(undefined)
            if (editingId === target.id) setEditingId(undefined)
            void store.remove(
              { scope: target.scope as 'profile' | 'home', id: target.id },
              target.config.serverName ?? target.id,
            )
          }}
        />
      ) : null}
    </Panel>
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
