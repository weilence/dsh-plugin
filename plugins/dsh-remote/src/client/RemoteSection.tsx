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
import type { ConnOp, ConnRow } from '../shared'
import { REMOTE_PROFILE } from '../shared'
import { messageText, type RemoteKey, type RemoteT } from './locales'
import { RemoteForm } from './RemoteForm'
import { SyncDialog } from './SyncDialog'
import type { RemoteStore } from './store'
import local from './RemoteSection.module.css'
import shared from '@dsh-plugins/client-ui/styles'

const styles = { ...shared, ...local }

export interface RemotePanelEnv {
  store: RemoteStore
}

const PHASE_PILL_KEYS: Record<ConnRow['state']['phase'], { key: RemoteKey; tone: PillData['tone'] }> = {
  idle: { key: 'phase.idle', tone: 'neutral' },
  probing: { key: 'phase.probing', tone: 'warn' },
  deploying: { key: 'phase.deploying', tone: 'warn' },
  starting: { key: 'phase.starting', tone: 'warn' },
  running: { key: 'phase.running', tone: 'ok' },
  stopping: { key: 'phase.stopping', tone: 'warn' },
  error: { key: 'phase.error', tone: 'err' },
}

const OP_LABEL_KEYS: Record<ConnOp['kind'], RemoteKey> = {
  test: 'op.test',
  connect: 'op.connect',
  disconnect: 'op.disconnect',
  'sync-skills': 'op.sync-skills',
  'sync-mcp': 'op.sync-mcp',
  'sync-plugins': 'op.sync-plugins',
  'sync-prompts': 'op.sync-prompts',
}

export function RemoteSection(props: RemotePanelEnv & SettingsSectionOwnerProps & { t: RemoteT }) {
  useWideSettingsDialog()
  return <RemotePanel {...props} env={props} />
}

function RemotePanel(props: SettingsSectionOwnerProps & { env: RemotePanelEnv; t: RemoteT }) {
  const { store } = props.env
  const { t } = props
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
    <Panel title={t('panel.title')}>
      {env !== undefined && !env.ssh ? (
        <div className={styles.error} role="alert">
          {t('env.noSsh')}
        </div>
      ) : null}
      {env !== undefined && env.ssh && !env.tar ? (
        <div className={styles.notice}>{t('env.noTar')}</div>
      ) : null}
      {state.error !== null ? (
        <div className={styles.error} role="alert">
          {messageText(state.error, t)}
        </div>
      ) : null}
      {state.notice !== null ? (
        <Toast
          key={String('key' in state.notice ? state.notice.key : state.notice.text)}
          text={messageText(state.notice, t)}
          holdMs={5000}
          onDone={() => store.dismissNotice()}
        />
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
          {t('panel.create')}
        </Button>
        <Button variant="outline" onClick={() => void store.refresh()}>
          {t('panel.refresh')}
        </Button>
      </div>

      {state.status === 'idle' ? <div className={styles.loading}>{t('panel.loading')}</div> : null}

      <div className={styles.rows} ref={rowsRef}>
        <CardList
          items={connections}
          getKey={(row) => row.id}
          renderCard={(row) => connectionCard(row, store, state, t)}
          listRef={rowsRef}
          empty={
            connections.length === 0 && !state.creating ? (
              <div className={styles.empty}>{t('panel.empty')}</div>
            ) : null
          }
          after={
            state.creating ? (
              <div className={local.creatingRow}>
                <RemoteForm
                  mode="create"
                  store={store}
                  t={t}
                  busy={state.busyId === 'new'}
                  error={state.error === null ? null : messageText(state.error, t)}
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
          t={t}
          localRows={state.localRows}
          busy={state.busyId === syncTarget.id || syncTarget.state.op !== null}
          onClose={() => store.askSync(null)}
        />
      ) : null}
      {connectTarget !== undefined ? (
        <Dialog
          title={t('connect.title')}
          description={t('connect.description', {
            label: connectTarget.label,
            alias: connectTarget.sshAlias,
          })}
          closeLabel={t('close')}
          onClose={() => store.askConnect(null)}
          actions={
            <>
              <Button variant="outline" onClick={() => store.askConnect(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  // 连接是长操作：随即关窗，进度由卡片 op pill 呈现，连接后用户重点一次菜单
                  store.askConnect(null)
                  void store.connect(connectTarget.id)
                }}
              >
                {t('op.connect')}
              </Button>
            </>
          }
          children={null}
        />
      ) : null}
      {deleteTarget !== undefined ? (
        <ConfirmDialog
          title={t('delete.title')}
          body={t('delete.body', { label: deleteTarget.label, alias: deleteTarget.sshAlias })}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
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
  t: RemoteT,
): ExpandableCardProps {
  const open = state.editingId === row.id
  const busy = state.busyId === row.id
  const op = row.state.op
  const opBusy = op !== null
  const running = row.state.running
  const testResult = state.testResult?.id === row.id ? state.testResult.result : null

  const phase = PHASE_PILL_KEYS[row.state.phase]
  const pills: PillData[] = [{ text: t(phase.key), tone: phase.tone }]
  if (op !== null) {
    pills.push({
      // op.step 是 host 侧事实（如 probe-node），原样拼接不翻译
      text: `${t(OP_LABEL_KEYS[op.kind])}${op.step !== undefined ? ` · ${op.step}` : ''}`,
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
          action(t('action.open'), () => window.open(running.url, '_blank'), { variant: 'primary' }),
          action(t('op.disconnect'), () => void store.disconnect(row.id)),
        ]
      : [
          action(t('action.test'), () => void store.test(row.id)),
          action(t('op.connect'), () => void store.connect(row.id), { variant: 'primary' }),
        ]
  const children = (
    <div>
      {row.state.lastSync.skills !== null ? (
        <p className={styles.rowWhen}>
          {t('lastSync.skills', { pushed: row.state.lastSync.skills.pushed })}
          {row.state.lastSync.skills.skipped > 0
            ? t('lastSync.skipped', { count: row.state.lastSync.skills.skipped })
            : ''}
          {t('lastSync.at', { at: new Date(row.state.lastSync.skills.at).toLocaleString() })}
        </p>
      ) : null}
      {row.state.lastSync.mcp !== null ? (
        <p className={styles.rowWhen}>
          {t('lastSync.mcp', { count: row.state.lastSync.mcp.installed.length })}
          {row.state.lastSync.mcp.skipped.length > 0
            ? t('lastSync.skipped', { count: row.state.lastSync.mcp.skipped.length })
            : ''}
          {t('lastSync.at', { at: new Date(row.state.lastSync.mcp.at).toLocaleString() })}
        </p>
      ) : null}
      {row.state.lastSync.plugins !== null ? (
        <p className={styles.rowWhen}>
          {t('lastSync.plugins', { count: row.state.lastSync.plugins.installed.length })}
          {row.state.lastSync.plugins.skipped.length > 0
            ? t('lastSync.skipped', { count: row.state.lastSync.plugins.skipped.length })
            : ''}
          {t('lastSync.at', { at: new Date(row.state.lastSync.plugins.at).toLocaleString() })}
        </p>
      ) : null}
      {row.state.lastSync.prompts !== null ? (
        <p className={styles.rowWhen}>
          {t('lastSync.prompts', {
            result: row.state.lastSync.prompts.pushed
              ? t('lastSync.prompts.pushed')
              : row.state.lastSync.prompts.skipped
                ? t('lastSync.prompts.skipped')
                : t('lastSync.prompts.unchanged'),
          })}
          {t('lastSync.at', { at: new Date(row.state.lastSync.prompts.at).toLocaleString() })}
        </p>
      ) : null}
      <RemoteForm
        mode="edit"
        row={row}
        store={store}
        t={t}
        busy={busy}
        error={state.error === null ? null : messageText(state.error, t)}
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
      t('card.profile', { profile: REMOTE_PROFILE }) +
      (running !== null
        ? ` · ${t('card.forward', { local: running.localPort, remote: running.remotePort })}`
        : '') +
      (testResult !== null
        ? ` · ${t('card.probe', {
            detail: testResult.ok
              ? t('card.probeDetail', {
                  node: testResult.nodeVersion ?? '?',
                  npm: testResult.npmVersion ?? '?',
                  dsh: testResult.dshVersion ?? t('card.probeNoDsh'),
                })
              : (testResult.error?.message ?? t('card.probeFailed')),
          })}`
        : ''),
    error: row.state.error?.message,
    actions: (
      <div className={local.actionCluster}>
        {actions}
        {/* skills / MCP / 提示词同步仅需 ssh 可达，全阶段常驻；插件安装依赖连接部署出的
            远端 dsh，未连接时引导先连接 */}
        <MenuButton
          label={t('card.syncMenu')}
          disabled={busy || opBusy}
          items={[
            { id: 'skills', label: t('op.sync-skills') },
            { id: 'mcp', label: t('op.sync-mcp') },
            { id: 'plugins', label: t('op.sync-plugins') },
            { id: 'prompts', label: t('op.sync-prompts') },
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
          title={row.state.running !== null ? t('card.deleteBlocked') : undefined}
          onClick={() => store.askDelete(row)}
        >
          {t('delete')}
        </Button>
      </div>
    ),
    children,
  }
}
