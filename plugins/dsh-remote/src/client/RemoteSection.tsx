import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  MenuSurface,
  StateDot,
  Toast,
  useAnchoredPosition,
} from '@deepseek-ai/dsh-client-ui-primitives'
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
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnOp, ConnProgress, ConnRow } from '../shared'
import { REMOTE_PROFILE } from '../shared'
import { messageText, type NS, type RemoteKey, type RemoteT } from './locales'
import { RemoteForm } from './RemoteForm'
import { SyncDialog } from './SyncDialog'
import type { RemoteStore } from './store'
import local from './RemoteSection.module.css'
import shared from '@dsh-plugins/client-ui/styles'

const styles = { ...shared, ...local }

/** 注册方注入面（client.tsx 装配，slot inject 回调提供）。 */
export interface RemoteSectionInjected {
  store: RemoteStore
}

const PHASE_PILL_KEYS: Record<ConnRow['state']['phase'], { key: RemoteKey; tone: PillData['tone'] }> = {
  idle: { key: 'phase.idle', tone: 'neutral' },
  probing: { key: 'phase.probing', tone: 'warn' },
  deploying: { key: 'phase.deploying', tone: 'warn' },
  starting: { key: 'phase.starting', tone: 'warn' },
  running: { key: 'phase.running', tone: 'ok' },
  error: { key: 'phase.error', tone: 'err' },
}

const OP_LABEL_KEYS: Record<ConnOp['kind'], RemoteKey> = {
  test: 'op.test',
  connect: 'op.connect',
  'sync-skills': 'op.sync-skills',
  'sync-mcp': 'op.sync-mcp',
  'sync-plugins': 'op.sync-plugins',
  'sync-prompts': 'op.sync-prompts',
}

/** error 阶段的入口文案按最近一次操作的类别取（progress 在 op 清空后仍保留）。 */
const FAILED_LABEL_KEYS: Record<ConnOp['kind'], RemoteKey> = {
  test: 'failed.test',
  connect: 'failed.connect',
  'sync-skills': 'failed.sync',
  'sync-mcp': 'failed.sync',
  'sync-plugins': 'failed.sync',
  'sync-prompts': 'failed.sync',
}

/** 操作步骤时间线（spinner 的 hover 浮层与失败详情弹窗共用）。 */
function StepTimeline(props: { progress: ConnProgress; title: string }) {
  return (
    <div className={local.opLog}>
      <p className={local.opLogTitle}>{props.title}</p>
      <ol className={local.opLogList}>
        {props.progress.steps.map((step, index) => (
          <li key={index}>
            <span className={local.opLogAt}>{new Date(step.at).toLocaleTimeString()}</span>
            {/* step / detail 是 host 侧事实（如 probe-node、版本号），原样展示不翻译 */}
            <span className={local.opLogStep}>
              {step.step}
              {step.detail !== undefined ? ` · ${step.detail}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** 进行中的 spinner + hover 过程浮层。浮层视觉与定位照 dsh-models 用量面板
 *  （官方 MenuSurface 材质 + useAnchoredPosition + body portal，z-index 1100
 *  高于设置弹窗的 1000）；触发为 hover——移出后留 250ms grace 供指针移入面板。 */
function OpHoverCard(props: { progress: ConnProgress; title: string }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pos = useAnchoredPosition({
    open,
    anchorRef: anchor,
    panelRef: surface,
    side: 'bottom',
    align: 'end',
    gap: 8,
    margin: 12,
  })
  const show = (): void => {
    if (grace.current !== null) clearTimeout(grace.current)
    setOpen(true)
  }
  const hide = (): void => {
    if (grace.current !== null) clearTimeout(grace.current)
    grace.current = setTimeout(() => setOpen(false), 250)
  }
  useEffect(
    () => () => {
      if (grace.current !== null) clearTimeout(grace.current)
    },
    [],
  )
  return (
    <span ref={anchor} className={local.opSpinWrap} onPointerEnter={show} onPointerLeave={hide}>
      <StateDot state="ongoing" size={16} />
      {open
        ? createPortal(
            <MenuSurface
              ref={surface}
              role="status"
              className={[local.opFlyout, pos === null ? local.measure : ''].filter(Boolean).join(' ')}
              style={pos ?? undefined}
              onPointerEnter={show}
              onPointerLeave={hide}
            >
              <StepTimeline progress={props.progress} title={props.title} />
            </MenuSurface>,
            document.body,
          )
        : null}
    </span>
  )
}

/** 完整组件 props：运行时份额 + locale 标准 seat + 注入面。 */
export type RemoteSectionProps = PropsRuntime<'settings.section'> &
  PropsLocale<typeof NS> &
  InjectFace<RemoteSectionInjected>

export function RemoteSection(props: RemoteSectionProps) {
  useWideSettingsDialog()
  const { store, t } = props
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
  const { syncing, deleting, connectPrompt, failedDetail } = state
  const syncTarget = syncing === null ? undefined : connections.find((row) => row.id === syncing.id)
  const deleteTarget = deleting === null ? undefined : connections.find((row) => row.id === deleting.id)
  const connectTarget =
    connectPrompt === null ? undefined : connections.find((row) => row.id === connectPrompt.id)
  const failedTarget =
    failedDetail === null ? undefined : connections.find((row) => row.id === failedDetail.id)

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
      {failedTarget !== undefined ? (
        <Dialog
          title={t(FAILED_LABEL_KEYS[failedTarget.state.progress?.kind ?? 'connect'])}
          closeLabel={t('close')}
          onClose={() => store.askFailedDetail(null)}
        >
          <div className={local.failedBody}>
            {failedTarget.state.error !== null ? (
              <p className={styles.error} role="alert">
                {failedTarget.state.error.message}
              </p>
            ) : null}
            {failedTarget.state.progress !== null ? (
              <StepTimeline progress={failedTarget.state.progress} title={t('card.opLog.title')} />
            ) : null}
            {failedTarget.state.error?.detail !== undefined && failedTarget.state.error.detail.length > 0 ? (
              <pre className={local.opLogPre}>{failedTarget.state.error.detail}</pre>
            ) : null}
          </div>
        </Dialog>
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
                  // 连接是长操作：随即关窗，进度由卡片 spinner（hover 看过程）呈现，连接后用户重点一次菜单
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
  // 进行中与失败态：文字进度 pill 全部让位（spinner 表进行中、失败入口表终态），
  // 过程细节一律经 progress 时间线呈现（hover / 点击详情）。
  const failed = row.state.phase === 'error' && row.state.op === null
  const pills: PillData[] = opBusy || failed ? [] : [{ text: t(phase.key), tone: phase.tone }]

  // 操作状态入口（spinner / 失败详情）占按钮区最左位，与动作按钮中心线对齐。
  // 过程浮层见 OpHoverCard（官方 MenuSurface，z-1100 在设置弹窗之上）。
  const opIndicator =
    op !== null && row.state.progress !== null ? (
      <OpHoverCard progress={row.state.progress} title={t(OP_LABEL_KEYS[op.kind])} />
    ) : failed ? (
      <button type="button" className={local.failedBadge} onClick={() => store.askFailedDetail(row)}>
        {t(FAILED_LABEL_KEYS[row.state.progress?.kind ?? 'connect'])}
      </button>
    ) : null

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
      ? [action(t('action.open'), () => window.open(running.url, '_blank'), { variant: 'primary' })]
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
    // 连接失败的摘要与全文都收敛进「连接失败」详情弹窗（actions 区入口）；同步失败
    // （连接仍在 running）保持摘要行 + 查看完整机制。
    error: failed ? undefined : row.state.error?.message,
    errorDetail:
      !failed &&
      row.state.error !== null &&
      row.state.error.detail !== undefined &&
      row.state.error.detail.length > 0
        ? {
            text: row.state.error.detail,
            title: t('card.errorDetail.title'),
            expandLabel: t('card.errorDetail.expand'),
            closeLabel: t('close'),
          }
        : undefined,
    actions: (
      <div className={local.actionCluster}>
        {opIndicator}
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
          disabled={busy || opBusy}
          onClick={() => store.askDelete(row)}
        >
          {t('delete')}
        </Button>
      </div>
    ),
    children,
  }
}
