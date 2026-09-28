import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PiAiOperations } from './operations'
import type { PanelStore } from './store'
import { RouteEditor } from './RouteEditor'
import { CreateProviderForm } from './CreateProviderForm'
import {
  CardList,
  ConfirmDialog,
  ExpandableCard,
  Panel,
  type ExpandableCardInfoItem,
} from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'

const styles = { ...shared }

const PROVIDER_ORDER_KEY = 'dsh-models/provider-order'

export interface ModelCatalogSectionProps extends SettingsSectionOwnerProps {
  store?: PanelStore
  operations?: PiAiOperations
}

export function ModelCatalogSection(props: ModelCatalogSectionProps) {
  const store = props.store
  const operations = props.operations
  if (!store || !operations) {
    return <div className={styles.empty}>模型目录面板尚未注入。</div>
  }
  return <ModelCatalogPanel store={store} operations={operations} close={props.close} />
}

function ModelCatalogPanel(props: { store: PanelStore; operations: PiAiOperations; close: () => void }) {
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
    setEditing(undefined)
    setEditingDirty(false)
    setCreating(true)
    if (dormant.length === 0) void props.store.ensureModelsDev()
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
    <Panel
      title="模型目录"
      subtitle={
        <>
          浏览 models.dev 并写入 <code className={styles.code}>llm-pi-ai</code>
          ；展开 Provider 卡片即可编辑连接与模型。
        </>
      }
    >
      {!writable ? <div className={styles.notice}>当前 Settings Provider 不可写，面板为只读。</div> : null}
      {state.error ? <div className={styles.error}>{state.error}</div> : null}
      {/* 一次性提示走官方 Toast：淡出后由 dismissNotice 清空 store。 */}
      {state.notice !== null ? (
        <Toast
          key={state.notice}
          text={state.notice}
          holdMs={5000}
          onDone={() => props.store.dismissNotice()}
        />
      ) : null}
      <div className={styles.listToolbar}>
        <Button variant="primary" disabled={busyProvider !== null} onClick={requestCreate}>
          新建 Provider
        </Button>
        <Button
          variant="outline"
          disabled={state.status === 'loading' || busyProvider !== null}
          onClick={() => void props.store.refresh()}
        >
          刷新
        </Button>
      </div>
      {state.status === 'loading' ? <div className={styles.loading}>正在读取 llm-pi-ai 配置…</div> : null}

      <CardList
        items={orderedRoutes}
        getKey={(route) => route.provider}
        onReorder={moveProvider}
        canDrag={(route) => editing !== route.provider && busyProvider === null}
        before={
          creating ? (
            <ExpandableCard
              title="新建 Provider"
              open
              onToggle={() => {
                if (busyProvider === null) setCreating(false)
              }}
            >
              <CreateProviderForm
                busy={busyProvider !== null}
                error={state.error}
                knownProviders={routes.map((route) => route.provider)}
                dormantProviders={dormant.map((route) => route.provider)}
                catalog={state.modelsDev}
                modelsDevLoading={state.modelsDevLoading}
                modelsDevError={state.modelsDevError}
                routes={routes}
                onCancel={() => setCreating(false)}
                onLoadCatalog={() => void props.store.ensureModelsDev()}
                onCreate={(provider, profile, apiKey) =>
                  props.store.createProvider(provider, profile, { apiKey })
                }
                onSaveProfile={(provider, profile, notice, apiKey) =>
                  props.store.createProvider(provider, profile, { apiKey })
                }
                onFetchModels={(request) => props.operations.discoverEndpoint(request)}
                onError={(message) => props.store.fail(message)}
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
                删除
              </Button>
            ),
            notice: route.error !== undefined ? <div className={styles.error}>{route.error}</div> : undefined,
            ariaLabel: `编辑 ${route.displayName}`,
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
                  error={state.error}
                  modelsDev={state.modelsDev}
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
              还没有配置任何 Provider；点「新建 Provider」开始（使用内置 / 自定义 Provider）。
              {dormant.length > 0 ? `（pi-ai 内置目录里有 ${dormant.length} 个可选 Provider，尚未配置）` : ''}
            </div>
          ) : null
        }
      />

      {pendingExit !== null ? (
        <ConfirmDialog
          title="放弃未保存的修改？"
          body="有未保存的修改，离开将丢弃。"
          confirmLabel="确定"
          busy={busyProvider !== null}
          onCancel={() => setPendingExit(null)}
          onConfirm={() => {
            setEditing(pendingExit.next)
            setEditingDirty(false)
            if (pendingExit.create) {
              setCreating(true)
              if (dormant.length === 0) void props.store.ensureModelsDev()
            }
            setPendingExit(null)
          }}
        />
      ) : null}

      {deleting !== undefined ? (
        <ConfirmDialog
          title={`删除 Provider ${deleting}`}
          body="只删除 llm-pi-ai 用户层里的这条 profile（凭据与组合层配置保留）。未保存的修改将一并丢弃。"
          confirmLabel="删除"
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
