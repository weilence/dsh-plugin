import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, StateDot, Tag, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  discoveredToCatalogEntry,
  lookupModelEntry,
  providerCatalogModels,
  type ModelsDevLookup,
} from '../catalog/matching'
import type { ModelsDevCatalog } from '../catalog/types'
import { jsonEqual } from '../pi-ai/ops'
import type { PiAiChoices } from '../pi-ai/choices'
import { errMsg } from '@dsh-plugins/shared'
import {
  modelEntries,
  foreignModelsBlocked,
  patchUserProfile,
  planAddModel,
  removeModelProfile,
  routeModelRows,
  routeSource,
  saveModelProfile,
  type DiscoveredModelFacts,
  type ModelRow,
} from '../pi-ai/profile'
import type { PiAiModelEntry, PiAiProviderEntry } from '../pi-ai/types'
import { validateProviderReasoning } from '../pi-ai/validate'
import { effortsLabel, type PanelRoute } from '../pi-ai/view'
import { deriveKeyRef, validateApiKey } from './operations'
import type { SignInView } from './SignInCard'
import { ModelForm } from './ModelForm'
import {
  CardList,
  ExpandableCard,
  SelectField,
  TextField,
  IssueList,
  formatTokenCount,
  type ExpandableCardInfoItem,
  type ExpandableCardProps,
} from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'
import local from './RouteEditor.module.css'

const styles = { ...shared, ...local }

export interface RouteEditorProps {
  route: PanelRoute
  choices: PiAiChoices
  /** 该 route 当前继承的目录事实（与写入共用同一输入）。 */
  catalog: ReadonlyMap<string, DiscoveredModelFacts>
  /** 凭据引用当前是否已配置（undefined = 未知）。 */
  keyConfigured: boolean | undefined
  writable: boolean
  busy: boolean
  error: string | null
  modelsDev: ModelsDevCatalog | null
  /**
   * 账号登录视图：route 的 Provider 带 oauth 登录且未显式配置 apiKeyEnv 时
   * 返回登录卡；replacesApiKey 时隐藏 API Key 字段（oauth-only）。
   */
  signInView?: (provider: string) => SignInView | null
  onLoadModelsDev(): Promise<ModelsDevCatalog | null>
  onDirtyChange(dirty: boolean): void
  onCancel(): void
  onExit(): void
  onFetchModels(request: {
    provider?: string
    baseURL: string
    api?: string
    apiKey?: string
  }): Promise<readonly { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]>
  /** 保存整份候选 profile；返回是否成功（成功后由调用方决定退出）。 */
  onSave(candidate: PiAiProviderEntry, apiKey?: string): Promise<boolean>
}

interface ProviderDraft {
  displayName: string
  api: string
  baseURL: string
  reasoning: string
}

function initialProviderDraft(route: PanelRoute): ProviderDraft {
  return {
    displayName: typeof route.userProfile?.displayName === 'string' ? route.userProfile.displayName : '',
    api: typeof route.userProfile?.api === 'string' ? route.userProfile.api : '',
    baseURL: typeof route.userProfile?.baseURL === 'string' ? route.userProfile.baseURL : '',
    reasoning: typeof route.userProfile?.reasoning === 'string' ? route.userProfile.reasoning : '',
  }
}

const BLANK_ROW: ModelRow = {
  id: '',
  name: '',
  userEntry: undefined,
  catalogEntry: undefined,
  writeSite: 'catalog',
}

// 「新增中」行的 key：NUL 不会出现在合法模型 id 里，避免与真实行的 key 冲突。
const CREATING_ROW_KEY = '\u0000creating'

// 只标注用户覆盖过的模型：纯目录继承是默认态，手写 route 与显式清单是
// route 级事实（弹窗标题已表达），逐行重复没有信息量。
function draftRowLabel(source: PanelRoute['source'], row: ModelRow): string | undefined {
  if (source === 'declared' || source === 'explicit') return undefined
  return row.userEntry === undefined ? undefined : '覆盖'
}

type ModelEdit = { creating: boolean; row: ModelRow }

// 连接继承：用户层没写过 api/baseURL 就沿用组合 base 的内置连接。模型编辑
// （override / 显式清单）不影响连接形态，不能据它翻开 Endpoint 字段。
function inheritsConnection(profile: PiAiProviderEntry | undefined): boolean {
  if (profile === undefined) return true
  return profile.api === undefined && profile.baseURL === undefined
}

export function RouteEditor(props: RouteEditorProps) {
  const { route } = props
  const [draftProfile, setDraftProfile] = useState<PiAiProviderEntry>(() =>
    route.userProfile === undefined ? {} : (structuredClone(route.userProfile) as PiAiProviderEntry),
  )
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(() => initialProviderDraft(route))
  const [key, setKey] = useState('')
  const [modelEdit, setModelEdit] = useState<ModelEdit | undefined>(undefined)
  const [touched, setTouched] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  /** 获取模型的结果反馈：显示在按钮旁边（弹窗顶部的提示区滚动在外，看不见）。 */
  const [fetchStatus, setFetchStatus] = useState<{ kind: 'ok' | 'info' | 'error'; text: string } | undefined>(
    undefined,
  )
  /** 新增模式下已实时应用到草稿的条目 id：支持边输入边改名（移除旧条目再重新规划）。 */
  const formAppliedIdRef = useRef<string | undefined>(undefined)
  /** 模型卡片列（.modelCards）：「新增中」卡片打开时把它滚进可视区。 */
  const modelListRef = useRef<HTMLDivElement | null>(null)
  // 账号登录卡：只在带 oauth flow 且用户未显式配置 apiKeyEnv 时参与（已显式
  // 指键的 route 保持原编辑形态）；replacesApiKey 时替换 Key 字段，双形态并排。
  const signIn = route.apiKeyEnv === undefined ? (props.signInView?.(route.provider) ?? null) : null

  const switchModelEdit = (next: ModelEdit | undefined) => {
    formAppliedIdRef.current = undefined
    setModelEdit(next)
  }
  // 连接继承的 route 不显示 Endpoint / 协议字段：api 与 baseURL 继续取组合 base，
  // 保存时也不把这两个键写进用户层。
  const inheritedConnection = !route.declared && inheritsConnection(route.userProfile)

  const keyRef =
    typeof draftProfile.apiKeyEnv === 'string' && draftProfile.apiKeyEnv.length > 0
      ? draftProfile.apiKeyEnv
      : deriveKeyRef(route.provider)

  const draftSource = useMemo(() => routeSource(route.declared, draftProfile), [route.declared, draftProfile])
  const rows = useMemo(
    () => routeModelRows(draftSource, draftProfile, props.catalog),
    [draftSource, draftProfile, props.catalog],
  )
  const catalogIds = useMemo(() => new Set(props.catalog.keys()), [props.catalog])
  // 目录 route（Host 注册表认识的 provider）：模型清单来自 pi-ai 安装目录，
  // 「获取模型」改从 models.dev 取更新鲜的清单，而不是问 Endpoint。
  const catalogRoute = props.catalog.size > 0

  const candidate = useMemo(() => {
    const next = patchUserProfile(draftProfile, {
      displayName: providerDraft.displayName.trim() || undefined,
      reasoning: providerDraft.reasoning.trim() || undefined,
      api: inheritedConnection ? undefined : providerDraft.api.trim() || undefined,
      baseURL: inheritedConnection ? undefined : providerDraft.baseURL.trim() || undefined,
    })
    if (key.trim().length > 0 && typeof next.apiKeyEnv !== 'string') next.apiKeyEnv = keyRef
    return next
  }, [draftProfile, providerDraft, key, keyRef, inheritedConnection])

  const keyError = key.trim().length > 0 ? validateApiKey(key) : undefined
  const dirty = !jsonEqual(candidate, route.userProfile ?? {}) || key.trim().length > 0
  useEffect(() => props.onDirtyChange(dirty), [dirty, props.onDirtyChange])

  const issues = useMemo(() => {
    const list: string[] = []
    const reasoningIssue = validateProviderReasoning(providerDraft.reasoning, props.choices.thinkingLevels)
    if (reasoningIssue !== undefined) list.push(reasoningIssue.message)
    if (!inheritedConnection) {
      if (route.declared && providerDraft.api.trim().length === 0) list.push('手写 route 必须指定 API 协议')
      if (route.declared && providerDraft.baseURL.trim().length === 0) {
        list.push('手写 route 必须指定 Endpoint')
      }
      if (providerDraft.baseURL.trim().length > 0 && !/^https?:\/\//i.test(providerDraft.baseURL.trim())) {
        list.push('Endpoint 必须是可解析的 HTTP 或 HTTPS URL')
      }
    }
    // 目录 route 删光模型同样得到空 models：与手写 route 一律拦在保存前。
    if (modelEntries(candidate).length === 0 && (candidate.models !== undefined || route.declared)) {
      list.push(
        route.declared
          ? '手写 route 至少要有一个模型'
          : '模型清单为空：保存前至少要有一个模型；不需要该 Provider 时请取消编辑并删除',
      )
    }
    // 混协议目录 route 的目录外模型无法解析协议，保存必被 Host 拒绝——提前
    // 拦下并点名，避免用户在死路的错误信息里猜原因。
    const blockedForeign = foreignModelsBlocked({
      provider: route.provider,
      routeApi: typeof candidate.api === 'string' ? candidate.api : undefined,
      models: modelEntries(candidate),
      catalog: catalogIds,
    })
    if (blockedForeign !== undefined) {
      const shown = blockedForeign.slice(0, 3).join('、')
      list.push(
        `${blockedForeign.length} 个模型不在 pi-ai 安装目录（${shown}${blockedForeign.length > 3 ? ' 等' : ''}），` +
          '且该 Provider 的目录模型协议不统一，无法为目录外模型指定协议；请删除这些行，等 pi-ai 目录收录后再获取',
      )
    }
    if (keyError !== undefined) list.push(keyError)
    return list
  }, [
    route.declared,
    route.provider,
    providerDraft,
    candidate,
    keyError,
    inheritedConnection,
    catalogIds,
    props.choices.thinkingLevels,
  ])

  const rowOf = (id: string) => route.rows.find((row) => row.id === id)
  const factsOf = (id: string) => rowOf(id)?.facts
  // route 级默认容量（schema 默认值）：模型表单容量留空时 placeholder 回退显示。
  const routeDefaults = {
    contextWindow:
      typeof route.effectiveProfile?.defaultContextWindow === 'number'
        ? route.effectiveProfile.defaultContextWindow
        : undefined,
    maxTokens:
      typeof route.effectiveProfile?.defaultMaxTokens === 'number'
        ? route.effectiveProfile.defaultMaxTokens
        : undefined,
  }

  const save = async () => {
    setTouched(true)
    setLocalError(null)
    // 模型表单实时折叠进草稿，保存成功后由列表收起当前卡片。
    if (issues.length > 0) return
    const ok = await props.onSave(candidate, key.trim().length > 0 ? key.trim() : undefined)
    if (ok) props.onExit()
  }

  /**
   * 模型表单实时应用：每次有效修改立即折叠进草稿，文件写入由外层「保存」
   * 统一完成。新增模式支持边输入边改名：id 变化时先移除上一次应用的旧条目，
   * 再按新 id 重新规划落点；编辑既有行时 id 不可改，按原位覆盖字段。
   */
  const applyModelLive = (entry: PiAiModelEntry) => {
    setLocalError(null)
    if (modelEdit === undefined) return
    if (!modelEdit.creating) {
      setDraftProfile(saveModelProfile(draftSource, draftProfile, modelEdit.row, entry))
      return
    }
    if (entry.id.trim().length === 0) return
    const appliedId = formAppliedIdRef.current
    if (appliedId !== undefined && appliedId === entry.id) {
      const baseRow = rows.find((row) => row.id === appliedId)
      if (baseRow !== undefined) {
        setDraftProfile(saveModelProfile(draftSource, draftProfile, baseRow, entry))
      }
      return
    }
    let profile = draftProfile
    let source = draftSource
    if (appliedId !== undefined) {
      const previous = rows.find((row) => row.id === appliedId)
      if (previous !== undefined) {
        profile = removeModelProfile(source, profile, previous, props.catalog)
        source = routeSource(route.declared, profile)
      }
    }
    const plan = planAddModel({ source, userProfile: profile, catalog: props.catalog, entry })
    if (plan.kind === 'blocked') {
      setLocalError(plan.reason)
      return
    }
    formAppliedIdRef.current = entry.id
    setDraftProfile(plan.profile)
  }

  const removeModel = (row: ModelRow) => {
    setDraftProfile(removeModelProfile(draftSource, draftProfile, row, props.catalog))
    // 删的是「新增中」已应用的条目：清掉应用标记，表单的下一次输入按新条目重新规划。
    if (formAppliedIdRef.current === row.id) formAppliedIdRef.current = undefined
    if (modelEdit !== undefined && modelEdit.row.id === row.id) switchModelEdit(undefined)
  }

  /**
   * 获取模型：目录 route 从 models.dev 拉该 Provider 的整份清单（Host 的模型
   * 发现对目录 route 只会原样返回 pi-ai 安装目录，而安装目录随包发布、滞后于
   * models.dev），自定义 route 按草稿的 Endpoint + 协议询问 Host（协议留空
   * 交给 Host 自行判断，凭据未填时回读已存密钥），元数据按 matching.ts 的
   * 匹配链自动补全。两种来源都逐个走 planAddModel 追加进草稿（已存在的跳
   * 过）；不要的用行上的「删除」移除，最后随「保存」一次性写入。
   */
  const fetchModels = async () => {
    const baseURL = providerDraft.baseURL.trim() || route.baseURL || ''
    if (!catalogRoute && baseURL.length === 0) {
      setFetchStatus({ kind: 'error', text: '没有可用的 Endpoint；请先在连接里填写' })
      return
    }
    const api = providerDraft.api.trim() || route.api || undefined
    setFetching(true)
    setFetchStatus(undefined)
    try {
      let entries: readonly PiAiModelEntry[]
      if (catalogRoute) {
        const metadataCatalog = props.modelsDev ?? (await props.onLoadModelsDev())
        const providerModels = providerCatalogModels(metadataCatalog, route.provider)
        if (providerModels === undefined) {
          setFetchStatus({ kind: 'error', text: 'models.dev 未收录该 Provider，无法获取更新的模型清单' })
          return
        }
        entries = providerModels
      } else {
        const [discovered, metadataCatalog] = await Promise.all([
          props.onFetchModels({
            provider: route.provider,
            baseURL,
            api,
          }),
          props.modelsDev === null ? props.onLoadModelsDev() : Promise.resolve(props.modelsDev),
        ])
        entries = discovered.map((model) => discoveredToCatalogEntry(metadataCatalog, model, route.provider))
      }
      let profile = draftProfile
      let source = draftSource
      const seen = new Set(rows.map((row) => row.id))
      let added = 0
      let skipped = 0
      for (const entry of entries) {
        if (seen.has(entry.id)) {
          skipped += 1
          continue
        }
        const plan = planAddModel({
          source,
          userProfile: profile,
          catalog: props.catalog,
          entry,
        })
        if (plan.kind === 'blocked') {
          setFetchStatus({ kind: 'error', text: plan.reason })
          return
        }
        profile = plan.profile
        source = routeSource(route.declared, profile)
        seen.add(entry.id)
        added += 1
      }
      // 循环里只累加了本地变量，必须在这里折叠回草稿状态。
      if (added > 0) setDraftProfile(profile)
      const sourceLabel = catalogRoute ? 'models.dev' : 'Endpoint'
      setFetchStatus(
        added === 0
          ? { kind: 'info', text: `没有新增模型：${sourceLabel} 返回的 id 都已存在` }
          : {
              kind: 'ok',
              text:
                skipped > 0
                  ? `获取成功：从 ${sourceLabel} 新增 ${added} 个模型，跳过 ${skipped} 个已存在`
                  : `获取成功：从 ${sourceLabel} 新增 ${added} 个模型`,
            },
      )
    } catch (error) {
      setFetchStatus({ kind: 'error', text: errMsg(error) })
    } finally {
      setFetching(false)
    }
  }

  // 新增模型的元数据查询：与「获取模型」同一条匹配链，route 的 provider 经
  // 别名表优先（zai-coding-cn 等订阅计划 route 用 models.dev 的计划专属
  // 条目，而不是厂商本体兜底）。
  const lookupMetadata = useCallback(
    async (id: string): Promise<ModelsDevLookup | undefined> => {
      const catalog = props.modelsDev ?? (await props.onLoadModelsDev())
      if (catalog === null) return undefined
      return lookupModelEntry(catalog, id, route.provider)
    },
    [props.modelsDev, props.onLoadModelsDev, route.provider],
  )

  // 仅显式清单 / 手写 route 有序（models 数组顺序即请求与展示顺序）；目录
  // route 的顺序由安装目录决定，面板不排序。from / to 是卡片下标：
  // 「新增中」的条目不占卡片位，重排只在可见卡片范围内进行，再把它放回
  // 末尾（与展示位置一致）。
  const reorderModel = (from: number, to: number) => {
    if (from === to) return
    if (draftSource !== 'explicit' && draftSource !== 'declared') return
    const entries = modelEntries(draftProfile)
    const creatingId = modelEdit !== undefined && modelEdit.creating ? formAppliedIdRef.current : undefined
    const visible = entries.filter((entry) => entry.id !== creatingId)
    if (from >= visible.length) return
    const [moved] = visible.splice(from, 1)
    visible.splice(Math.min(Math.max(to, 0), visible.length), 0, moved)
    const tail = creatingId !== undefined ? entries.filter((entry) => entry.id === creatingId) : []
    setDraftProfile(
      patchUserProfile(draftProfile, { models: [...visible, ...tail], modelOverrides: undefined }),
    )
  }

  const editingId = modelEdit !== undefined && !modelEdit.creating ? modelEdit.row.id : undefined
  // 「新增中」的条目已实时写进草稿：从常规卡片里摘掉、固定以带「新增」徽标的
  // 卡片显示在清单末尾，避免同一模型出现两张卡。
  const creatingApplied =
    modelEdit !== undefined && modelEdit.creating && formAppliedIdRef.current !== undefined
      ? rows.find((row) => row.id === formAppliedIdRef.current)
      : undefined
  const displayRows =
    creatingApplied !== undefined ? rows.filter((row) => row.id !== creatingApplied.id) : rows

  const modelForm =
    modelEdit === undefined ? undefined : (
      <ModelForm
        key={`${modelEdit.creating ? 'add' : 'edit'}:${modelEdit.row.id}`}
        row={modelEdit.row}
        creating={modelEdit.creating}
        existingRows={modelEdit.creating ? displayRows : rows.filter((row) => row.id !== modelEdit.row.id)}
        facts={modelEdit.creating ? undefined : factsOf(modelEdit.row.id)}
        routeDefaults={routeDefaults}
        catalogIds={route.declared ? undefined : catalogIds}
        busy={props.busy}
        onChange={applyModelLive}
        onLookupMetadata={lookupMetadata}
      />
    )

  // 卡片行头的 label / value 信息项：与列表页表格同一条回退链（条目 → 生效接口
  // → route 默认），未显式配置的容量显示 —。
  const modelInfo = (row: ModelRow): ExpandableCardInfoItem[] => {
    const entry: PiAiModelEntry | undefined = row.userEntry ?? row.catalogEntry
    const rowFacts = factsOf(row.id)
    const panelRow = rowOf(row.id)
    const ctx = entry?.contextWindow ?? rowFacts?.contextWindow ?? panelRow?.effectiveContextWindow
    const out = entry?.maxTokens ?? rowFacts?.defaultMaxTokens ?? panelRow?.effectiveMaxTokens
    const input = entry?.input ?? rowFacts?.inputModalities
    return [
      { label: 'ctx', value: ctx === undefined ? '—' : formatTokenCount(ctx) },
      { label: 'out', value: out === undefined ? '—' : formatTokenCount(out) },
      { label: '模态', value: input === undefined || input.length === 0 ? '—' : input.join('+') },
      { label: '推理', value: entry === undefined ? '默认' : effortsLabel(entry) },
    ]
  }

  const canReorder = draftSource === 'explicit' || draftSource === 'declared'

  const modelCard = (row: ModelRow): Omit<ExpandableCardProps, 'dragging' | 'dropLine' | 'dragHandlers'> => {
    const expanded = row.id === editingId
    const badge = draftRowLabel(draftSource, row)
    return {
      open: expanded,
      // 再点一次行头收起；点其他卡片切换编辑目标（改动已实时进草稿，无丢失）。
      onToggle: () => (expanded ? switchModelEdit(undefined) : switchModelEdit({ creating: false, row })),
      title: row.name,
      meta: row.id,
      badge: badge !== undefined ? <Tag>{badge}</Tag> : undefined,
      info: modelInfo(row),
      actions: (
        <Button
          variant="ghost"
          size="sm"
          className={styles.dangerGhost}
          disabled={props.busy}
          // 只改草稿，保存时才真正写入：无需二次确认。
          onClick={() => removeModel(row)}
        >
          删除
        </Button>
      ),
      children: expanded ? modelForm : undefined,
    }
  }

  // 「新增中」卡片固定在清单末尾并处于展开编辑态；未输入 id 时只有占位标题。
  const creatingCard =
    modelEdit !== undefined && modelEdit.creating ? (
      <ExpandableCard
        key={CREATING_ROW_KEY}
        open
        onToggle={() => switchModelEdit(undefined)}
        title={creatingApplied !== undefined ? creatingApplied.name : '新模型'}
        meta={creatingApplied !== undefined ? creatingApplied.id : undefined}
        badge={<Tag>新增</Tag>}
        info={creatingApplied !== undefined ? modelInfo(creatingApplied) : undefined}
        actions={
          creatingApplied !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              className={styles.dangerGhost}
              disabled={props.busy}
              onClick={() => removeModel(creatingApplied)}
            >
              删除
            </Button>
          ) : undefined
        }
      >
        {modelForm}
      </ExpandableCard>
    ) : undefined

  // 「新增中」卡片追加在清单末尾，展开的表单常在视口外：打开时把它滚进来
  // （block: 'nearest'，本就在视口内时不产生滚动；输入过程中不重复滚动）。
  useEffect(() => {
    if (modelEdit === undefined || !modelEdit.creating) return
    modelListRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' })
  }, [modelEdit])

  return (
    <div className={styles.inlineEditor}>
      {!props.writable ? (
        <div className={styles.notice}>当前 Settings Provider 不可写；可继续编辑，但无法保存。</div>
      ) : null}
      {route.error ? <div className={styles.error}>{route.error}</div> : null}

      <div className={styles.editorMain}>
        <section className={styles.section}>
          <div className={styles.grid}>
            {signIn?.replacesApiKey !== true ? (
              <TextField
                label={
                  <>
                    新的 API Key
                    {props.keyConfigured !== undefined ? (
                      <>
                        {' '}
                        <StateDot
                          className={styles.inlineDot}
                          state={props.keyConfigured ? 'done' : 'warning'}
                        />
                        {props.keyConfigured ? '已配置' : '未配置'}
                      </>
                    ) : null}
                  </>
                }
                type="password"
                autoComplete="off"
                placeholder="留空则不修改"
                value={key}
                disabled={props.busy}
                error={keyError}
                onChange={setKey}
              />
            ) : null}
            <TextField
              label="显示名"
              value={providerDraft.displayName}
              disabled={props.busy}
              placeholder={route.displayName || route.provider}
              onChange={(value) => setProviderDraft({ ...providerDraft, displayName: value })}
            />
            {inheritedConnection ? null : (
              <TextField
                label="Endpoint（baseURL）"
                value={providerDraft.baseURL}
                disabled={props.busy}
                placeholder={route.baseURL ?? 'https://gateway.example/v1'}
                onChange={(value) => setProviderDraft({ ...providerDraft, baseURL: value })}
              />
            )}
            {inheritedConnection ? null : (
              <SelectField
                label="API 协议"
                value={providerDraft.api}
                disabled={props.busy}
                options={props.choices.protocols.map((protocol) => ({
                  value: protocol,
                  label: protocol,
                }))}
                onChange={(value) => setProviderDraft({ ...providerDraft, api: value })}
              />
            )}
            <SelectField
              label="默认推理等级（reasoning，可选）"
              value={providerDraft.reasoning}
              disabled={props.busy}
              options={[
                { value: '', label: '继承默认' },
                ...props.choices.thinkingLevels.map((level) => ({ value: level, label: level })),
                ...(providerDraft.reasoning.length > 0 &&
                !props.choices.thinkingLevels.some((level) => level === providerDraft.reasoning)
                  ? [
                      {
                        value: providerDraft.reasoning,
                        label: `未知等级：${providerDraft.reasoning}`,
                        disabled: true,
                      },
                    ]
                  : []),
              ]}
              onChange={(value) => setProviderDraft({ ...providerDraft, reasoning: value })}
            />
          </div>
          {signIn?.card}
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>模型（{rows.length}）</h3>
          {/* 删除目录内模型 / 新增目录外模型都会把草稿翻成显式清单：目录升级不再
              自动生效，提示必须持续可见而不是只在触发的那一下闪现。 */}
          {(route.source === 'inherited' || route.source === 'overridden') && draftSource === 'explicit' ? (
            <div className={styles.notice}>
              本次保存会把该 route 固定为一份显式模型清单；之后 pi-ai 目录升级新增的模型不会再自动出现。
            </div>
          ) : null}
          <CardList
            items={displayRows}
            getKey={(row) => row.id}
            renderCard={modelCard}
            onReorder={canReorder ? reorderModel : undefined}
            canDrag={() => !props.busy}
            after={creatingCard}
            empty={
              creatingCard === undefined ? (
                <div className={styles.empty}>
                  {route.declared
                    ? '手写 route 至少需要一个模型'
                    : route.active
                      ? '该 route 当前没有模型'
                      : '该 route 未激活或未配置模型'}
                </div>
              ) : null
            }
            listRef={modelListRef}
          />
          <div className={styles.toolbar}>
            <Button
              variant="outline"
              icon={<IconPlusOutlineRegular />}
              disabled={props.busy}
              onClick={() =>
                modelEdit !== undefined && modelEdit.creating
                  ? switchModelEdit(undefined)
                  : switchModelEdit({ creating: true, row: BLANK_ROW })
              }
            >
              新增模型
            </Button>
            <Button
              variant="outline"
              disabled={props.busy || fetching}
              onClick={() => {
                void fetchModels()
              }}
            >
              {fetching ? '获取中…' : '获取模型'}
            </Button>
          </div>
          {fetchStatus !== undefined ? (
            <div
              className={
                fetchStatus.kind === 'ok'
                  ? styles.success
                  : fetchStatus.kind === 'error'
                    ? styles.error
                    : styles.notice
              }
              role={fetchStatus.kind === 'error' ? 'alert' : undefined}
            >
              {fetchStatus.text}
            </div>
          ) : null}
        </section>
      </div>

      {/* 保存相关反馈贴着动作区：表单长时顶部的提示区在视口外，点了保存看不见被拦的原因。 */}
      {props.error ? <div className={styles.error}>{props.error}</div> : null}
      {localError ? <div className={styles.error}>{localError}</div> : null}
      {touched && issues.length > 0 ? <IssueList issues={issues.map((message) => ({ message }))} /> : null}
      <div className={styles.editorActions}>
        <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
          取消
        </Button>
        <Button variant="primary" disabled={props.busy || !props.writable} onClick={() => void save()}>
          {props.busy ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
