import { useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CardList,
  ConfirmDialog,
  Dialog,
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
  connect: '连接',
  disconnect: '断开',
  'sync-skills': '同步 Skills',
  'sync-mcp': '同步 MCP',
  'sync-plugins': '同步插件',
  'sync-prompts': '同步提示词',
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
  const { syncing, deleting, connectPrompt } = state
  const syncTarget = syncing === null ? undefined : connections.find((row) => row.id === syncing.id)
  const deleteTarget = deleting === null ? undefined : connections.find((row) => row.id === deleting.id)
  const connectTarget =
    connectPrompt === null ? undefined : connections.find((row) => row.id === connectPrompt.id)

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
          本机未找到 tar：Skills 同步不可用（Windows 10+ 自带 bsdtar，请确认其在 PATH 上）。
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

      {/* 弹窗挂在面板顶层：ExpandableCard 收起时不渲染 children，放卡片里
          会出现「点了菜单/删除却要展开行才弹窗」。 */}
      {syncing !== null && syncTarget !== undefined ? (
        <SyncDialog
          row={syncTarget}
          kind={syncing.kind}
          store={store}
          localRows={state.localRows}
          busy={state.busyId === syncTarget.id || syncTarget.state.op !== null}
          onClose={() => store.askSync(null)}
        />
      ) : null}
      {connectTarget !== undefined ? (
        <Dialog
          title="连接远端"
          description={`同步插件需要远端已连接。现在连接「${connectTarget.label}」（${connectTarget.sshAlias}）？`}
          onClose={() => store.askConnect(null)}
          actions={
            <>
              <Button variant="outline" onClick={() => store.askConnect(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  // 连接是长操作：随即关窗，进度由卡片 op pill 呈现，连接后用户重点一次菜单
                  store.askConnect(null)
                  void store.connect(connectTarget.id)
                }}
              >
                连接
              </Button>
            </>
          }
          children={null}
        />
      ) : null}
      {deleteTarget !== undefined ? (
        <ConfirmDialog
          title="删除连接"
          body={`确认删除「${deleteTarget.label}」（${deleteTarget.sshAlias}）？远端产物（~/.dsh/dsh-remote/ 运行目录、已装插件与已下发配置）会保留。`}
          confirmLabel="删除"
          busy={state.busyId === deleteTarget.id}
          onCancel={() => store.askDelete(null)}
          onConfirm={() => void store.remove(deleteTarget.id)}
        />
      ) : null}
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
          action('断开', () => void store.disconnect(row.id)),
        ]
      : [
          action('测试', () => void store.test(row.id)),
          action('连接', () => void store.connect(row.id), { variant: 'primary' }),
        ]
  const children = (
    <div>
      {row.state.lastSync.skills !== null ? (
        <p className={styles.rowWhen}>
          上次 Skills 同步：推送 {row.state.lastSync.skills.pushed}
          {row.state.lastSync.skills.skipped > 0
            ? ` · 跳过 ${row.state.lastSync.skills.skipped}（已一致）`
            : ''}
          （{new Date(row.state.lastSync.skills.at).toLocaleString()}）
        </p>
      ) : null}
      {row.state.lastSync.mcp !== null ? (
        <p className={styles.rowWhen}>
          上次 MCP 同步：{row.state.lastSync.mcp.installed.length} 行
          {row.state.lastSync.mcp.skipped.length > 0
            ? ` · 跳过 ${row.state.lastSync.mcp.skipped.length}（已一致）`
            : ''}
          （{new Date(row.state.lastSync.mcp.at).toLocaleString()}）
        </p>
      ) : null}
      {row.state.lastSync.plugins !== null ? (
        <p className={styles.rowWhen}>
          上次插件同步：装 {row.state.lastSync.plugins.installed.length}
          {row.state.lastSync.plugins.skipped.length > 0
            ? ` · 跳过 ${row.state.lastSync.plugins.skipped.length}（已一致）`
            : ''}
          （{new Date(row.state.lastSync.plugins.at).toLocaleString()}）
        </p>
      ) : null}
      {row.state.lastSync.prompts !== null ? (
        <p className={styles.rowWhen}>
          上次提示词同步：
          {row.state.lastSync.prompts.pushed
            ? '已推送'
            : row.state.lastSync.prompts.skipped
              ? '内容一致（跳过）'
              : '未勾选（未变更）'}
          （{new Date(row.state.lastSync.prompts.at).toLocaleString()}）
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
        {/* skills / MCP / 提示词同步仅需 ssh 可达，全阶段常驻；插件安装依赖连接部署出的
            远端 dsh，未连接时引导先连接 */}
        <MenuButton
          label="同步 ▾"
          disabled={busy || opBusy}
          items={[
            { id: 'skills', label: '同步 Skills' },
            { id: 'mcp', label: '同步 MCP' },
            { id: 'plugins', label: '同步插件' },
            { id: 'prompts', label: '同步提示词' },
          ]}
          onSelect={(id) => {
            if (id === 'skills' || id === 'mcp' || id === 'plugins' || id === 'prompts') {
              if (id === 'plugins' && row.state.running === null) store.askConnect(row)
              else store.askSync({ id: row.id, kind: id })
            }
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
