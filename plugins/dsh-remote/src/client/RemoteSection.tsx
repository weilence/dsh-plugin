/**
 * 设置页「远程开发」面板：连接为可展开卡片（ExpandableCard）——状态 pill
 * （七相）+ 运行 url + 错误行；动作按钮按相渲染（idle：测试 / 部署 / 连接；
 * running：打开 / 复制 / 断开）；三类同步在任意非忙相位可用。展开体是行内
 * 编辑表单（RemoteForm）+ 最近同步摘要 + 删除（ConfirmDialog）。新建连接
 * 卡片追加在列表末尾并滚动进视口（同 dsh-mcp 的行内新建模式）。
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Button, Toast, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CardList,
  ConfirmDialog,
  MenuButton,
  Panel,
  useWideSettingsDialog,
  type ExpandableCardProps,
  type PillData,
} from '@dsh-plugins/client-ui'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnRow } from '../shared'
import { REMOTE_PROFILE } from '../shared'
import { RemoteForm } from './RemoteForm'
import { SyncDialog } from './SyncDialog'
import type { RemoteStore } from './store'
import local from './RemoteSection.module.css'
import shared from '@dsh-plugins/client-ui/styles'

const styles = { ...shared, ...local }

export interface RemotePanelEnv {
  store: RemoteStore
}

const PHASE_PILLS: Record<ConnRow['state']['phase'], PillData> = {
  idle: { text: '空闲', tone: 'neutral' },
  probing: { text: '探测中', tone: 'warn' },
  deploying: { text: '部署中', tone: 'warn' },
  starting: { text: '启动中', tone: 'warn' },
  running: { text: '运行中', tone: 'ok' },
  stopping: { text: '断开中', tone: 'warn' },
  error: { text: '错误', tone: 'err' },
}

const OP_LABELS: Record<string, string> = {
  test: '测试连接',
  deploy: '部署',
  connect: '连接',
  disconnect: '断开',
  'sync-skills': '同步 skills',
  'sync-mcp': '下发 MCP',
  'sync-plugins': '同步插件',
  'sync-all': '同步',
}

export function RemoteSection(props: RemotePanelEnv & SettingsSectionOwnerProps) {
  useWideSettingsDialog()
  return <RemotePanel {...props} env={props} />
}

function RemotePanel(props: SettingsSectionOwnerProps & { env: RemotePanelEnv }) {
  const { store } = props.env
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const rowsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    store.startPolling()
    void store.loadLocalRows()
    return () => store.stopPolling()
  }, [store])

  useEffect(() => {
    if (state.creating) rowsRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' })
  }, [state.creating])

  const connections = state.list?.connections ?? []
  const env = state.list?.env

  return (
    <Panel title="远程开发">
      {env !== undefined && !env.ssh ? (
        <div className={styles.error} role="alert">
          本机未找到 ssh 可执行文件：请安装 OpenSSH 客户端（Windows 的「可选功能 → OpenSSH
          客户端」）；在此之前所有远端操作不可用。
        </div>
      ) : null}
      {env !== undefined && env.ssh && !env.tar ? (
        <div className={styles.notice}>
          本机未找到 tar：skills 同步不可用（Windows 10+ 自带 bsdtar，请确认其在 PATH 上）。
        </div>
      ) : null}
      {state.error !== null ? (
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
          disabled={state.creating}
          onClick={() => {
            store.create()
            void store.loadLocalRows()
          }}
        >
          新建连接
        </Button>
        <Button variant="outline" onClick={() => void store.refresh()}>
          刷新
        </Button>
      </div>

      {state.status === 'idle' ? <div className={styles.loading}>正在读取连接库…</div> : null}

      <div className={styles.rows} ref={rowsRef}>
        <CardList
          items={connections}
          getKey={(row) => row.id}
          renderCard={(row) => connectionCard(row, store, state)}
          listRef={rowsRef}
          empty={
            connections.length === 0 && !state.creating ? (
              <div className={styles.empty}>还没有远程开发连接。</div>
            ) : null
          }
          after={
            state.creating ? (
              <div className={local.creatingRow}>
                <RemoteForm
                  mode="create"
                  store={store}
                  busy={state.busyId === 'new'}
                  error={state.error}
                  onDone={() => store.edit(undefined)}
                  onCancel={() => store.edit(undefined)}
                />
              </div>
            ) : null
          }
        />
      </div>
    </Panel>
  )
}

function connectionCard(
  row: ConnRow,
  store: RemoteStore,
  state: ReturnType<RemoteStore['getSnapshot']>,
): ExpandableCardProps {
  const open = state.editingId === row.id
  const busy = state.busyId === row.id
  const op = row.state.op
  const opBusy = op !== null
  const running = row.state.running
  const testResult = state.testResult?.id === row.id ? state.testResult.result : null

  const pills: PillData[] = [PHASE_PILLS[row.state.phase]]
  if (op !== null) {
    pills.push({
      text: `${OP_LABELS[op.kind] ?? op.kind}${op.step !== undefined ? ` · ${op.step}` : ''}`,
      tone: 'warn',
    })
  }

  const action = (
    label: string,
    onClick: () => void,
    options?: { variant?: 'primary' | 'outline' },
  ): ReactElement => (
    <Button size="sm" variant={options?.variant ?? 'ghost'} disabled={busy || opBusy} onClick={onClick}>
      {label}
    </Button>
  )

  const actions =
    row.state.phase === 'running' && running !== null
      ? [
          action('打开', () => window.open(running.url, '_blank'), { variant: 'primary' }),
          <CopyUrlButton key="copy" url={running.url} disabled={busy || opBusy} />,
          action('断开', () => void store.disconnect(row.id)),
        ]
      : [
          action('测试', () => void store.test(row.id)),
          action('部署', () => void store.deploy(row.id)),
          action('连接', () => void store.connect(row.id), { variant: 'primary' }),
        ]
  const children = (
    <div>
      {row.state.lastSync.skills !== null ? (
        <p className={styles.rowWhen}>
          上次 skills 同步：推送 {row.state.lastSync.skills.pushed} · 删除 {row.state.lastSync.skills.deleted}{' '}
          · 空根 {row.state.lastSync.skills.skipped}（
          {new Date(row.state.lastSync.skills.at).toLocaleString()}）
        </p>
      ) : null}
      {row.state.lastSync.mcp !== null ? (
        <p className={styles.rowWhen}>
          上次 MCP 下发：{row.state.lastSync.mcp.installed.length} 行
          {row.state.lastSync.mcp.removed.length > 0
            ? ` · 移除 ${row.state.lastSync.mcp.removed.length} 行`
            : ''}
          （{new Date(row.state.lastSync.mcp.at).toLocaleString()}）
        </p>
      ) : null}
      {row.state.lastSync.plugins !== null ? (
        <p className={styles.rowWhen}>
          上次插件同步：装 {row.state.lastSync.plugins.installed.length} · 卸{' '}
          {row.state.lastSync.plugins.removed.length}
          {row.state.lastSync.plugins.skipped.length > 0
            ? ` · 跳过 ${row.state.lastSync.plugins.skipped.length}（本机已无此插件）`
            : ''}
          （{new Date(row.state.lastSync.plugins.at).toLocaleString()}）
        </p>
      ) : null}
      <RemoteForm
        mode="edit"
        row={row}
        store={store}
        busy={busy}
        error={state.error}
        onDone={() => store.edit(undefined)}
        onCancel={() => store.edit(undefined)}
      />
      {state.deleting?.id === row.id ? (
        <ConfirmDialog
          title="删除连接"
          body={`确认删除「${row.label}」（${row.sshAlias}）？远端产物（~/.dsh/dsh-remote/ 运行目录、已装插件与已下发配置）会保留。`}
          confirmLabel="删除"
          busy={busy}
          onCancel={() => store.askDelete(null)}
          onConfirm={() => void store.remove(row.id)}
        />
      ) : null}
      {state.syncing?.id === row.id ? (
        <SyncDialog
          row={row}
          kind={state.syncing.kind === 'all' ? 'plugins' : state.syncing.kind}
          store={store}
          localRows={state.localRows}
          busy={busy || opBusy}
          onClose={() => store.askSync(null)}
        />
      ) : null}
    </div>
  )

  return {
    open,
    onToggle: () => (opBusy ? undefined : store.edit(open ? undefined : row.id)),
    title: row.label,
    meta: row.sshAlias,
    pills,
    description: running !== null ? running.url : undefined,
    note:
      `远端 profile ${REMOTE_PROFILE}（固定）` +
      (running !== null ? ` · 端口 ${running.localPort} → ${running.remotePort}` : '') +
      (testResult !== null
        ? ` · 探针：${
            testResult.ok
              ? `node ${testResult.nodeVersion ?? '?'} / npm ${testResult.npmVersion ?? '?'} / dsh ${testResult.dshVersion ?? '未装'}`
              : (testResult.error?.message ?? '失败')
          }`
        : ''),
    error: row.state.error?.message,
    actions: (
      <div className={local.actionCluster}>
        {actions}
        <MenuButton
          label="同步 ▾"
          disabled={busy || opBusy}
          items={[
            { id: 'skills', label: '同步 skills…' },
            { id: 'mcp', label: '下发 MCP…' },
            { id: 'plugins', label: '同步插件…' },
          ]}
          onSelect={(id) => {
            if (id === 'skills' || id === 'mcp' || id === 'plugins') store.askSync({ id: row.id, kind: id })
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          className={styles.dangerGhost}
          disabled={busy || opBusy || row.state.running !== null}
          title={row.state.running !== null ? '先断开连接再删除' : undefined}
          onClick={() => store.askDelete(row)}
        >
          删除
        </Button>
      </div>
    ),
    children,
  }
}

function CopyUrlButton(props: { url: string; disabled: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={props.disabled}
      onClick={() => {
        void writeClipboard(props.url).then((ok) => {
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1000)
        })
      }}
    >
      {copied ? '已复制' : '复制 URL'}
    </Button>
  )
}
