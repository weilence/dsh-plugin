import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardList, ConfirmDialog, ExpandableCard, Panel, useWideSettingsDialog } from '@dsh-plugins/client-ui'
import type { McpRow } from '../shared'
import { endpointOf, transportOf } from '../mcpConfig'
import { messageText, type McpT } from './locales'
import type { McpStore } from './store'
import { McpServerForm, McpServerView } from './McpServerForm'
import shared from '@dsh-plugins/client-ui/styles'
import local from './McpSection.module.css'

const styles = { ...shared, ...local }

/** 面板注入面（client.tsx 装配，槽位 inject 回调提供）。 */
export interface McpPanelEnv {
  store: McpStore
  t: McpT
}

export function McpSection(props: McpPanelEnv & SettingsSectionOwnerProps) {
  useWideSettingsDialog()
  const { store, t } = props
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
  const errorText = state.error === null ? null : messageText(state.error, t)
  const noticeText = state.notice === null ? null : messageText(state.notice, t)

  const collapse = (): void => {
    setCreating(false)
    setEditingId(undefined)
  }

  return (
    <Panel title={t('section.label')}>
      {errorText ? (
        <div className={styles.error} role="alert">
          {errorText}
        </div>
      ) : null}
      {noticeText !== null ? (
        <Toast key={noticeText} text={noticeText} holdMs={5000} onDone={() => store.dismissNotice()} />
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
          {t('action.create')}
        </Button>
        <Button variant="outline" disabled={state.status === 'loading'} onClick={() => void store.refresh()}>
          {t('action.refresh')}
        </Button>
      </div>
      {state.status === 'loading' ? <div className={styles.loading}>{t('list.loading')}</div> : null}

      <CardList
        items={servers}
        getKey={(row) => `${row.scope}:${row.id}`}
        before={
          // 新建卡片在列表顶部：触发按钮就在上方，长列表也不会把表单推到视口外。
          creating ? (
            <ExpandableCard
              title={t('action.create')}
              open
              onToggle={() => {
                if (!busy) setCreating(false)
              }}
            >
              <McpServerForm
                mode="create"
                store={store}
                t={t}
                busy={busy}
                error={errorText}
                onDone={collapse}
                onCancel={collapse}
              />
            </ExpandableCard>
          ) : null
        }
        empty={
          state.status === 'ready' && !creating ? <div className={styles.empty}>{t('list.empty')}</div> : null
        }
        renderCard={(row) => {
          const editable = row.editable && (row.scope === 'profile' || row.scope === 'home')
          const badge = statusBadge(row, t)
          const expanded = editingId === row.id
          const transport = transportOf(row.config)
          return {
            title: row.config.serverName ?? t('row.unnamed'),
            pills: [
              ...(transport !== undefined ? [{ text: transport === 'stdio' ? 'stdio' : 'HTTP' }] : []),
              { text: editable ? t('row.editable') : t('row.readOnly'), tone: editable ? 'ok' : 'warn' },
              {
                text: badge.text,
                tone: badge.kind === 'on' ? 'ok' : badge.kind === 'err' ? 'err' : 'neutral',
                title: badge.title,
              },
            ],
            description: endpointOf(row.config) || t('row.endpointMissing'),
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
                  {row.disabled ? t('action.enable') : t('action.disable')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.dangerGhost}
                  disabled={busy}
                  onClick={() => setDeleting(row)}
                >
                  {t('delete')}
                </Button>
              </>
            ) : null,
            children: expanded ? (
              editable && editing !== undefined ? (
                <McpServerForm
                  mode="edit"
                  row={editing}
                  store={store}
                  t={t}
                  busy={busy}
                  error={errorText}
                  onDone={collapse}
                  onCancel={collapse}
                />
              ) : (
                <McpServerView row={row} t={t} />
              )
            ) : null,
          }
        }}
      />

      {deleting !== undefined ? (
        <ConfirmDialog
          title={t('delete.title', { name: deleting.config.serverName ?? deleting.id })}
          body={t('delete.body', { id: deleting.id })}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
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

function statusBadge(
  row: McpRow,
  t: McpT,
): { text: string; kind: 'on' | 'off' | 'err' | 'warn'; title?: string } {
  if (row.disabled) return { text: t('row.disabled'), kind: 'off' }
  if (row.live === null) return { text: t('row.pendingEffect'), kind: 'off' }
  switch (row.live.status) {
    case 'active':
      return { text: t('row.activeTools', { count: row.live.tools.length }), kind: 'on' }
    case 'loading':
    case 'pending':
      return { text: t('row.connecting'), kind: 'warn' }
    case 'failed':
      return { text: t('row.connectFailed'), kind: 'err', title: row.live.error }
    case 'disposed':
    case 'unloading':
      return { text: t('row.unloaded'), kind: 'off' }
    case 'absent':
      return { text: t('row.absent'), kind: 'off' }
  }
}
