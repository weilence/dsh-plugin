import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PiAiOperations } from './operations'
import type { ModelsT } from './locales'
import { messageText } from './locales'
import type { PanelStore } from './store'
import { RouteEditor } from './RouteEditor'
import { CreateProviderForm } from './CreateProviderForm'
import { SignInCard, type SignInView } from './SignInCard'
import {
  CardList,
  ConfirmDialog,
  ExpandableCard,
  Panel,
  useWideSettingsDialog,
  type ExpandableCardInfoItem,
} from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'

const styles = { ...shared }

const PROVIDER_ORDER_KEY = 'dsh-models/provider-order'

export interface ModelCatalogSectionProps extends SettingsSectionOwnerProps {
  store?: PanelStore
  operations?: PiAiOperations
  t?: ModelsT
}

export function ModelCatalogSection(props: ModelCatalogSectionProps) {
  useWideSettingsDialog()
  const store = props.store
  const operations = props.operations
  if (!store || !operations || !props.t) {
    return <div className={styles.empty}>模型目录面板尚未注入。</div>
  }
  return <ModelCatalogPanel store={store} operations={operations} t={props.t} close={props.close} />
}

function ModelCatalogPanel(props: {
  store: PanelStore
  operations: PiAiOperations
  t: ModelsT
  close: () => void
}) {
  const { t } = props
  const state = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  // notice 的唯一清除路径是 Toast 的 onDone，而 Toast 计时只在挂载期间有效：
  // 面板卸载会连 Toast 一起卸载，残留 notice 会在下次打开时重放成「刚保存过」
  // 的假象，因此卸载时同步清掉。
  useEffect(() => () => props.store.dismissNotice(), [props.store])
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [editingDirty, setEditingDirty] = useState(false)
  const [pendingExit, setPendingExit] = useState<{ next?: string; create?: true } | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | undefined>(undefined)
  const [keyState, setKeyState] = useState<Record<string, boolean | undefined>>({})

  // useMemo 保持引用稳定：直接 filter 每次渲染产生新数组，下面的凭据 effect
  // 将配合 setState 形成「describe 不停调用」的无限循环。
  const routes = useMemo(() => state.routes.filter((route) => route.configured), [state.routes])
  /** 尚未配置的 pi-ai 内置 provider（仅作新建流程的候选，不参与查重）。 */
  const dormant = useMemo(() => state.routes.filter((route) => !route.configured), [state.routes])
  useEffect(() => {
    let cancelled = false
    for (const route of routes) {
      void props.store.credentialState(route.provider, route.apiKeyEnv).then((result) => {
        if (cancelled || !result) return
        setKeyState((previous) =>
          previous[route.provider] === result.configured
            ? previous
            : { ...previous, [route.provider]: result.configured },
        )
      })
    }
    return () => {
      cancelled = true
    }
  }, [props.store, routes])

  const writable = state.writable
  const busyProvider = state.busy

  // 账号登录视图：flows 只含带 oauth 方法的 Provider（Host 已过滤，api-key
  // 型的「登录」等价于 API Key 字段，不进此面）；replacesApiKey 依据 flow
  // 是否还提供 api-key 方法——双形态 Provider 卡与 Key 字段并排。
  const signInView = useCallback(
    (provider: string): SignInView | null => {
      const flow = state.auth.flows[provider]
      if (flow === undefined) return null
      return {
        card: (
          <SignInCard
            provider={provider}
            flow={flow}
            auth={state.auth}
            replacesApiKey={!flow.methods.some((method) => method.id === 'api-key')}
            t={t}
            onBegin={(target) => void props.store.beginSignIn(target)}
            onAnswer={(value) => void props.store.answerSignIn(value)}
            onDecline={() => void props.store.declineSignIn()}
            onCancel={() => void props.store.cancelSignIn()}
            onSignOut={(target) => void props.store.signOut(target)}
          />
        ),
        replacesApiKey: !flow.methods.some((method) => method.id === 'api-key'),
      }
    },
    [state.auth, props.store, t],
  )

  const requestEdit = (next?: string) => {
    if (busyProvider !== null || editing === next) return
    if (editing !== undefined && editingDirty) {
      setPendingExit({ next })
      return
    }
    setEditing(next)
    setEditingDirty(false)
    setCreating(false)
  }

  const switchToCreate = (next?: string) => {
    setEditing(next)
    setEditingDirty(false)
    setCreating(true)
    if (dormant.length === 0) void props.store.ensureModelsDev()
  }

  const requestCreate = () => {
    if (busyProvider !== null) return
    if (creating) {
      setCreating(false)
      return
    }
    if (editing !== undefined && editingDirty) {
      setPendingExit({ create: true })
      return
    }
    switchToCreate()
  }

  const [providerOrder, setProviderOrder] = useState<string[] | null>(() => {
    try {
      const raw = window.localStorage.getItem(PROVIDER_ORDER_KEY)
      const parsed: unknown = raw === null ? null : JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : null
    } catch {
      return null
    }
  })

  const orderedRoutes = useMemo(() => {
    if (providerOrder === null) return routes
    const position = new Map(providerOrder.map((id, order) => [id, order]))
    return [...routes].sort(
      (a, b) =>
        (position.get(a.provider) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(b.provider) ?? Number.MAX_SAFE_INTEGER),
    )
  }, [routes, providerOrder])

  const moveProvider = (from: number, to: number) => {
    const ids = orderedRoutes.map((route) => route.provider)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    setProviderOrder(ids)
    try {
      window.localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(ids))
    } catch {
      // 本地存储不可用（隐私模式等）时顺序仅本次会话生效。
    }
  }

  return (
    <Panel title={t('panel.title')} subtitle={t('panel.subtitle')}>
      {!writable ? <div className={styles.notice}>{t('panel.readOnly')}</div> : null}
      {state.error ? <div className={styles.error}>{messageText(state.error, t)}</div> : null}
      {/* 一次性提示走官方 Toast：淡出后由 dismissNotice 清空 store。 */}
      {state.notice !== null ? (
        <Toast
          key={String('key' in state.notice ? state.notice.key : state.notice.text)}
          text={messageText(state.notice, t)}
          holdMs={5000}
          onDone={() => props.store.dismissNotice()}
        />
      ) : null}
      <div className={styles.listToolbar}>
        <Button variant="primary" disabled={busyProvider !== null} onClick={requestCreate}>
          {t('panel.createProvider')}
        </Button>
        <Button
          variant="outline"
          disabled={state.status === 'loading' || busyProvider !== null}
          onClick={() => void props.store.refresh()}
        >
          {t('usage.refresh')}
        </Button>
      </div>
      {state.status === 'loading' ? <div className={styles.loading}>{t('panel.loading')}</div> : null}

      <CardList
        items={orderedRoutes}
        getKey={(route) => route.provider}
        onReorder={moveProvider}
        canDrag={(route) => editing !== route.provider && busyProvider === null}
        before={
          creating ? (
            <ExpandableCard
              title={t('panel.createProvider')}
              open
              onToggle={() => {
                if (busyProvider === null) setCreating(false)
              }}
            >
              <CreateProviderForm
                busy={busyProvider !== null}
                error={state.error === null ? null : messageText(state.error, t)}
                dormantProviders={dormant.map((route) => route.provider)}
                catalog={state.modelsDev}
                modelsDevLoading={state.modelsDevLoading}
                modelsDevError={state.modelsDevError}
                routes={routes}
                protocols={state.choices.protocols}
                signInView={signInView}
                t={t}
                onCancel={() => setCreating(false)}
                onLoadCatalog={() => void props.store.ensureModelsDev()}
                onCreate={(provider, profile, apiKey) =>
                  props.store.createProvider(provider, profile, { apiKey })
                }
                onSaveProfile={(provider, profile, notice, apiKey) =>
                  props.store.createProvider(provider, profile, { apiKey, notice })
                }
                onFetchModels={(request) => props.operations.discoverEndpoint(request)}
                onError={(message) => props.store.fail({ text: message })}
              />
            </ExpandableCard>
          ) : null
        }
        renderCard={(route) => {
          const info: ExpandableCardInfoItem[] = []
          if (route.api !== undefined) info.push({ label: 'API', value: route.api })
          if (route.baseURL !== undefined) info.push({ label: 'Endpoint', value: route.baseURL })
          return {
            open: editing === route.provider,
            onToggle: () => requestEdit(editing === route.provider ? undefined : route.provider),
            title: route.displayName,
            meta: route.provider,
            info,
            actions: (
              <Button
                variant="ghost"
                size="sm"
                className={styles.dangerGhost}
                disabled={busyProvider !== null}
                onClick={() => setDeleting(route.provider)}
              >
                {t('panel.delete')}
              </Button>
            ),
            notice: route.error !== undefined ? <div className={styles.error}>{route.error}</div> : undefined,
            ariaLabel: t('panel.editProvider', { name: route.displayName }),
            children:
              editing === route.provider ? (
                <RouteEditor
                  key={route.provider}
                  route={route}
                  choices={state.choices}
                  catalog={props.store.catalogOf(route.provider)}
                  keyConfigured={keyState[route.provider]}
                  writable={writable}
                  busy={busyProvider === route.provider}
                  error={state.error === null ? null : messageText(state.error, t)}
                  modelsDev={state.modelsDev}
                  signInView={signInView}
                  t={t}
                  onLoadModelsDev={() => props.store.ensureModelsDev()}
                  onDirtyChange={setEditingDirty}
                  onCancel={() => requestEdit(undefined)}
                  onExit={() => {
                    setEditing(undefined)
                    setEditingDirty(false)
                  }}
                  onFetchModels={(request) => props.operations.discoverEndpoint(request)}
                  onSave={(candidate, apiKey) => props.store.saveRoute(route.provider, candidate, { apiKey })}
                />
              ) : null,
          }
        }}
        empty={
          state.status === 'ready' && !creating ? (
            <div className={styles.empty}>
              {t('panel.empty')}
              {dormant.length > 0 ? t('panel.emptyDormant', { count: dormant.length }) : ''}
            </div>
          ) : null
        }
      />

      {pendingExit !== null ? (
        <ConfirmDialog
          title={t('panel.discardTitle')}
          body={t('panel.discardBody')}
          confirmLabel={t('panel.confirm')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
          busy={busyProvider !== null}
          onCancel={() => setPendingExit(null)}
          onConfirm={() => {
            if (pendingExit.create) switchToCreate(pendingExit.next)
            else {
              setEditing(pendingExit.next)
              setEditingDirty(false)
            }
            setPendingExit(null)
          }}
        />
      ) : null}

      {deleting !== undefined ? (
        <ConfirmDialog
          title={t('panel.deleteProviderTitle', { provider: deleting })}
          body={t('panel.deleteProviderBody')}
          confirmLabel={t('panel.delete')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
          busy={busyProvider !== null}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const target = deleting
            void props.store.deleteProvider(target).then(() => {
              setDeleting(undefined)
              if (editing === target) {
                setEditing(undefined)
                setEditingDirty(false)
              }
            })
          }}
        />
      ) : null}
    </Panel>
  )
}
