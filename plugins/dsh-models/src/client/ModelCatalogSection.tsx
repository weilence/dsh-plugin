import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { reasoningLabel, type PanelRoute } from '../pi-ai/view'
import type { PiAiOperations } from './operations'
import type { PanelStore } from './store'
import { RouteEditor } from './RouteEditor'
import { CreateProviderDialog } from './CreateProviderDialog'
import { ModelTable } from '@dsh-plugins/client-ui'
import {
  ConfirmDialog,
  ExpandableCard,
  Panel,
  useRowDragReorder,
  type ExpandableCardInfoItem,
  type RowDragHandlers,
} from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'

const styles = { ...shared }

const PROVIDER_ORDER_KEY = 'dsh-models/provider-order'

function RouteRow(props: {
  route: PanelRoute
  busy: boolean
  onEdit(): void
  onDelete(): void
  dragging: boolean
  dropLine: 'top' | 'bottom' | null
  /** 行拖拽属性：start / end 在表头，over / drop 在整卡。 */
  dragHandlers: RowDragHandlers
}) {
  const { route, dragHandlers } = props
  const [open, setOpen] = useState(false)
  const info: ExpandableCardInfoItem[] = []
  if (route.api !== undefined) info.push({ label: 'API', value: route.api })
  if (route.baseURL !== undefined) info.push({ label: 'Endpoint', value: route.baseURL })
  return (
    <ExpandableCard
      open={open}
      onToggle={() => setOpen(!open)}
      title={route.displayName}
      meta={route.provider}
      info={info}
      actions={
        <>
          <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onEdit}>
            编辑
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
      }
      notice={route.error !== undefined ? <div className={styles.error}>{route.error}</div> : undefined}
      scrollBody
      ariaLabel={`展开 ${route.displayName} 的模型清单`}
      dragging={props.dragging}
      dropLine={props.dropLine}
      dragHandlers={props.dragHandlers}
    >
      {route.rows.length > 0 ? (
        <ModelTable
          rows={route.rows.map((row) => ({
            name: row.name,
            id: row.id,
            ctx: row.effectiveContextWindow,
            out: row.effectiveMaxTokens,
            input: row.effectiveInput,
            reasoning: reasoningLabel(row),
          }))}
        />
      ) : (
        <div className={styles.empty}>
          {route.active ? '该 route 当前没有可用模型' : '该 route 未激活或未配置模型'}
        </div>
      )}
    </ExpandableCard>
  )
}

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
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | undefined>(undefined)
  const [keyState, setKeyState] = useState<Record<string, boolean | undefined>>({})

  // useMemo 保持引用稳定：直接 filter 每次渲染产生新数组，下面的凭据 effect
  // 将配合 setState 形成「describe 不停调用」的无限循环。
  const routes = useMemo(() => state.routes.filter((route) => route.configured), [state.routes])
  /** 尚未配置的 pi-ai 内置 provider（仅作新建流程的候选，不参与查重）。 */
  const dormant = useMemo(() => state.routes.filter((route) => !route.configured), [state.routes])
  const editingRoute = editing === undefined ? undefined : routes.find((route) => route.provider === editing)

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
  const providerDrag = useRowDragReorder(moveProvider)

  return (
    <Panel
      title="模型目录"
      subtitle={
        <>
          浏览 models.dev 并写入 <code className={styles.code}>llm-pi-ai</code>
          ；点「编辑」在弹窗中编辑该 Provider。
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
        <Button variant="primary" onClick={() => setCreating(true)}>
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

      <div className={styles.rows}>
        {orderedRoutes.map((route, index) => (
          <RouteRow
            key={route.provider}
            route={route}
            busy={busyProvider === route.provider}
            onEdit={() => setEditing(route.provider)}
            onDelete={() => setDeleting(route.provider)}
            dragging={providerDrag.isDragging(index)}
            dropLine={providerDrag.lineAt(index, orderedRoutes.length)}
            dragHandlers={providerDrag.rowProps(index, route.provider)}
          />
        ))}
        {routes.length === 0 && state.status === 'ready' ? (
          <div className={styles.empty}>
            还没有配置任何 Provider；点「新建 Provider」开始（使用内置 / 自定义 Provider）。
            {dormant.length > 0 ? `（pi-ai 内置目录里有 ${dormant.length} 个可选 Provider，尚未配置）` : ''}
          </div>
        ) : null}
      </div>

      {editingRoute ? (
        <RouteEditor
          key={editingRoute.provider}
          route={editingRoute}
          choices={state.choices}
          catalog={props.store.catalogOf(editingRoute.provider)}
          keyConfigured={keyState[editingRoute.provider]}
          writable={writable}
          busy={busyProvider === editingRoute.provider}
          error={state.error}
          modelsDev={state.modelsDev}
          onLoadModelsDev={() => props.store.ensureModelsDev()}
          onExit={() => setEditing(undefined)}
          onFetchModels={(request) => props.operations.discoverEndpoint(request)}
          onSave={(candidate, apiKey) => props.store.saveRoute(editingRoute.provider, candidate, { apiKey })}
          onDelete={async () => {
            await props.store.deleteProvider(editingRoute.provider)
            setEditing(undefined)
          }}
        />
      ) : null}

      {deleting !== undefined ? (
        <ConfirmDialog
          title={`删除 Provider ${deleting}`}
          body="只删除 llm-pi-ai 用户层里的这条 profile（凭据与组合层配置保留）。"
          confirmLabel="删除"
          busy={busyProvider !== null}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            void props.store.deleteProvider(deleting).then(() => setDeleting(undefined))
          }}
        />
      ) : null}

      {creating ? (
        <CreateProviderDialog
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
          onCreate={(provider, profile, apiKey) => {
            void props.store.createProvider(provider, profile, { apiKey })
            setCreating(false)
          }}
          onSaveProfile={(provider, profile, notice, apiKey) =>
            props.store.createProvider(provider, profile, { apiKey })
          }
          onFetchModels={(request) => props.operations.discoverEndpoint(request)}
          onError={(message) => props.store.fail(message)}
        />
      ) : null}
    </Panel>
  )
}
