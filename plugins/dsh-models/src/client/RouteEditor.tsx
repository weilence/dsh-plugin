import { useMemo, useRef, useState } from 'react'
import {
  Button,
  Input,
  Modal,
  StateDot,
  Switch,
  IconPlusOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { discoveredToCatalogEntry } from '../catalog/matching'
import type { ModelsDevCatalog } from '../catalog/types'
import { jsonEqual } from '../pi-ai/ops'
import type { PiAiChoices } from '../pi-ai/choices'
import {
  modelEntries,
  patchUserProfile,
  planAddModel,
  removeModelProfile,
  resetToCatalog,
  routeModelRows,
  routeSource,
  saveModelProfile,
  type DiscoveredModelFacts,
  type ModelRow,
} from '../pi-ai/profile'
import type { PiAiModelEntry, PiAiProviderEntry } from '../pi-ai/types'
import { effortsLabel, type PanelRoute } from '../pi-ai/view'
import { deriveKeyRef, validateApiKey } from './operations'
import { ModelForm } from './ModelForm'
import { ModelTable } from './ModelTable'
import { ConfirmDialog, TextField, SelectField, fieldInputCls, IssueList } from '@dsh-plugins/client-ui'
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
  onLoadModelsDev(): Promise<ModelsDevCatalog | null>
  /** 返回列表（放弃未保存修改，脏时内部会先确认）。 */
  onExit(): void
  onFetchModels(request: {
    provider?: string
    baseURL: string
    api?: string
    apiKey?: string
  }): Promise<readonly { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]>
  /** 保存整份候选 profile；返回是否成功（成功后由调用方决定退出）。 */
  onSave(candidate: PiAiProviderEntry, apiKey?: string): Promise<boolean>
  /** 删除该 route 的用户层 profile（立即执行）。 */
  onDelete(): void
}

interface ProviderDraft {
  displayName: string
  api: string
  baseURL: string
}

function initialProviderDraft(route: PanelRoute): ProviderDraft {
  return {
    displayName: typeof route.userProfile?.displayName === 'string' ? route.userProfile.displayName : '',
    api: typeof route.userProfile?.api === 'string' ? route.userProfile.api : '',
    baseURL: typeof route.userProfile?.baseURL === 'string' ? route.userProfile.baseURL : '',
  }
}

const BLANK_ROW: ModelRow = {
  id: '',
  name: '',
  userEntry: undefined,
  catalogEntry: undefined,
  writeSite: 'catalog',
}

// 只标注用户覆盖过的模型：纯目录继承是默认态，手写 route 与显式清单是
// route 级事实（弹窗标题已表达），逐行重复没有信息量。
function draftRowLabel(source: PanelRoute['source'], row: ModelRow): string | undefined {
  if (source === 'declared' || source === 'explicit') return undefined
  return row.userEntry === undefined ? undefined : '覆盖'
}

type ModelEdit = { creating: boolean; row: ModelRow }

type Confirm = { kind: 'leave' } | { kind: 'reset' } | { kind: 'delete' }

function isBuiltinOnly(profile: PiAiProviderEntry | undefined): boolean {
  if (profile === undefined) return true
  return Object.keys(profile).every((key) => key === 'apiKeyEnv')
}

export function RouteEditor(props: RouteEditorProps) {
  const { route } = props
  const [draftProfile, setDraftProfile] = useState<PiAiProviderEntry>(() =>
    route.userProfile === undefined ? {} : (structuredClone(route.userProfile) as PiAiProviderEntry),
  )
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(() => initialProviderDraft(route))
  const [key, setKey] = useState('')
  const [modelEdit, setModelEdit] = useState<ModelEdit | undefined>(undefined)
  const [confirm, setConfirm] = useState<Confirm | undefined>(undefined)
  const [touched, setTouched] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  /** 获取模型的结果反馈：显示在按钮旁边（弹窗顶部的提示区滚动在外，看不见）。 */
  const [fetchStatus, setFetchStatus] = useState<{ kind: 'ok' | 'info' | 'error'; text: string } | undefined>(
    undefined,
  )
  /** 新增模式下已实时应用到草稿的条目 id：支持边输入边改名（移除旧条目再重新规划）。 */
  const formAppliedIdRef = useRef<string | undefined>(undefined)

  const switchModelEdit = (next: ModelEdit | undefined) => {
    formAppliedIdRef.current = undefined
    setModelEdit(next)
  }
  // 「使用内置配置」：勾选后用户层只保留 API Key 引用，取消勾选时恢复勾选前
  // 的草稿；备份初始为挂载时的原始 profile（「初始即勾选」的 route 取消勾选
  // 时必须回到原始配置，否则 apiKeyEnv 会从候选里丢掉）。
  const [useBuiltin, setUseBuiltin] = useState<boolean>(
    () => !route.declared && isBuiltinOnly(route.userProfile),
  )
  const builtinBackupRef = useRef<PiAiProviderEntry>(
    route.userProfile === undefined ? {} : (structuredClone(route.userProfile) as PiAiProviderEntry),
  )

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

  const candidate = useMemo(() => {
    const next = patchUserProfile(
      draftProfile,
      useBuiltin
        ? {}
        : {
            displayName: providerDraft.displayName.trim() || undefined,
            api: providerDraft.api.trim() || undefined,
            baseURL: providerDraft.baseURL.trim() || undefined,
          },
    )
    if (key.trim().length > 0 && typeof next.apiKeyEnv !== 'string') next.apiKeyEnv = keyRef
    return next
  }, [draftProfile, providerDraft, key, keyRef, useBuiltin])

  const keyError = key.trim().length > 0 ? validateApiKey(key) : undefined
  const dirty = !jsonEqual(candidate, route.userProfile ?? {}) || key.trim().length > 0

  const issues = useMemo(() => {
    const list: string[] = []
    if (!useBuiltin) {
      if (route.declared && providerDraft.api.trim().length === 0) list.push('手写 route 必须指定 API 协议')
      if (route.declared && providerDraft.baseURL.trim().length === 0) {
        list.push('手写 route 必须指定 Endpoint')
      }
      if (providerDraft.baseURL.trim().length > 0 && !/^https?:\/\//i.test(providerDraft.baseURL.trim())) {
        list.push('Endpoint 必须是可解析的 HTTP 或 HTTPS URL')
      }
      if (modelEntries(candidate).length === 0 && (candidate.models !== undefined || route.declared)) {
        list.push(
          route.declared
            ? '手写 route 至少要有一个模型'
            : '模型清单为空；若要恢复目录继承，请点「恢复目录继承」',
        )
      }
    }
    if (keyError !== undefined) list.push(keyError)
    return list
  }, [route.declared, providerDraft, candidate, keyError, useBuiltin])

  const toggleUseBuiltin = (checked: boolean) => {
    if (checked) {
      builtinBackupRef.current = draftProfile
      const rest: PiAiProviderEntry = {}
      if (typeof draftProfile.apiKeyEnv === 'string' && draftProfile.apiKeyEnv.length > 0) {
        rest.apiKeyEnv = draftProfile.apiKeyEnv
      }
      setDraftProfile(rest)
      setModelEdit(undefined)
    } else {
      setDraftProfile(builtinBackupRef.current)
    }
    setUseBuiltin(checked)
  }

  const rowOf = (id: string) => route.rows.find((row) => row.id === id)
  const factsOf = (id: string) => rowOf(id)?.facts
  // route 级默认容量（schema 默认值）：模型表单容量留空时 placeholder 兜底显示。
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
    // 模型表单无需先关闭：修改都实时折叠进草稿，未通过校验的中间态不会
    // 进入草稿；保存成功后整个弹窗关闭。
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
        profile = removeModelProfile(source, profile, previous)
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
    setDraftProfile(removeModelProfile(draftSource, draftProfile, row))
    if (modelEdit !== undefined && modelEdit.row.id === row.id) switchModelEdit(undefined)
  }

  /**
   * 获取模型：按草稿的 Endpoint + 协议询问 Host（协议留空交给 Host 自行
   * 判断，凭据未填时回读已存密钥），返回的模型逐个走 planAddModel 追加进
   * 草稿（已存在的跳过），元数据按 matching.ts 的匹配链自动补全；不要的
   * 用行上的「删除」移除，最后随「保存」一次性写入。
   */
  const fetchModels = async () => {
    const baseURL = providerDraft.baseURL.trim() || route.baseURL || ''
    if (baseURL.length === 0) {
      setFetchStatus({ kind: 'error', text: '没有可用的 Endpoint；请先在连接里填写' })
      return
    }
    const api = providerDraft.api.trim() || route.api || undefined
    setFetching(true)
    setFetchStatus(undefined)
    try {
      const [discovered, metadataCatalog] = await Promise.all([
        props.onFetchModels({
          provider: route.provider,
          baseURL,
          api,
        }),
        props.modelsDev === null ? props.onLoadModelsDev() : Promise.resolve(props.modelsDev),
      ])
      let profile = draftProfile
      let source = draftSource
      const seen = new Set(rows.map((row) => row.id))
      let added = 0
      let skipped = 0
      for (const model of discovered) {
        if (seen.has(model.id)) {
          skipped += 1
          continue
        }
        const plan = planAddModel({
          source,
          userProfile: profile,
          catalog: props.catalog,
          entry: discoveredToCatalogEntry(metadataCatalog, model, route.provider),
        })
        if (plan.kind === 'blocked') {
          setFetchStatus({ kind: 'error', text: plan.reason })
          return
        }
        profile = plan.profile
        source = routeSource(route.declared, profile)
        seen.add(model.id)
        added += 1
      }
      // 循环里只累加了本地变量，必须在这里折叠回草稿状态。
      if (added > 0) setDraftProfile(profile)
      setFetchStatus(
        added === 0
          ? { kind: 'info', text: '没有新增模型：Endpoint 返回的 id 都已存在' }
          : {
              kind: 'ok',
              text:
                skipped > 0
                  ? `获取成功：新增 ${added} 个模型，跳过 ${skipped} 个已存在`
                  : `获取成功：新增 ${added} 个模型`,
            },
      )
    } catch (error) {
      const message = (error as { message?: string } | null | undefined)?.message
      setFetchStatus({ kind: 'error', text: message || String(error) })
    } finally {
      setFetching(false)
    }
  }

  // 仅显式清单 / 手写 route 有序（models 数组顺序即请求与展示顺序）；目录
  // route 的顺序由安装目录决定，面板不排序。
  const reorderModel = (from: number, to: number) => {
    if (from === to) return
    if (draftSource !== 'explicit' && draftSource !== 'declared') return
    const entries = [...modelEntries(draftProfile)]
    const [moved] = entries.splice(from, 1)
    entries.splice(to, 0, moved)
    setDraftProfile(patchUserProfile(draftProfile, { models: entries, modelOverrides: undefined }))
  }

  const requestLeave = () => {
    if (dirty) setConfirm({ kind: 'leave' })
    else props.onExit()
  }

  // busy 或确认对话框打开时忽略；确认框是官方 Modal 的上一层，Escape 由
  // 层栈保证先关它。
  const handleClose = () => {
    if (props.busy || confirm !== undefined) return
    requestLeave()
  }

  return (
    <Modal
      open
      onClose={handleClose}
      title={`编辑 Provider · ${route.provider}`}
      closeLabel="关闭"
      description={`${route.declared ? '手写 route（pi-ai 不内置）' : 'pi-ai 目录 route'}${
        route.active ? ' · 活动中' : ' · 未激活'
      } · 保存将整值写入该 route 的用户层配置`}
      className={styles.dialog}
      contentClassName={styles.scrollBody}
      footer={
        <div className={styles.footer}>
          <span className={styles.footerMeta}>
            {useBuiltin
              ? '内置配置：用户层只保留 API Key 引用，其余全部继承安装目录'
              : draftSource === 'declared'
                ? '手写清单：保存将改写该 route 的 models 数组'
                : draftSource === 'explicit'
                  ? '显式清单：保存将改写 models 数组条目'
                  : '目录 route：仅写 modelOverrides，其余目录模型保持继承'}
          </span>
          <div className={styles.actions}>
            {!route.declared && !useBuiltin ? (
              <Button variant="outline" disabled={props.busy} onClick={() => setConfirm({ kind: 'reset' })}>
                恢复目录继承
              </Button>
            ) : null}
            <Button
              variant="primary"
              className={styles.dangerButton}
              disabled={props.busy}
              onClick={() => setConfirm({ kind: 'delete' })}
            >
              删除 Provider
            </Button>
            <Button variant="outline" disabled={props.busy} onClick={requestLeave}>
              取消
            </Button>
            <Button variant="primary" disabled={props.busy || !props.writable} onClick={() => void save()}>
              {props.busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      }
    >
      {props.error ? <div className={styles.error}>{props.error}</div> : null}
      {localError ? <div className={styles.error}>{localError}</div> : null}
      {touched && issues.length > 0 ? <IssueList issues={issues.map((message) => ({ message }))} /> : null}
      {!props.writable ? (
        <div className={styles.notice}>当前 Settings Provider 不可写；可继续编辑，但无法保存。</div>
      ) : null}
      {route.error ? <div className={styles.error}>{route.error}</div> : null}

      <div className={styles.editorMain}>
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>API Key</h3>
          <label className={styles.field}>
            <span className={styles.label}>新的 API Key</span>
            <Input
              className={fieldInputCls(props.busy)}
              type="password"
              autoComplete="off"
              placeholder="留空则不修改"
              value={key}
              disabled={props.busy}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>{' '}
          {keyError !== undefined ? <div className={styles.error}>{keyError}</div> : null}
          <p className={styles.hint}>
            当前凭据引用：<code className={styles.code}>{keyRef}</code>
            {props.keyConfigured === undefined ? (
              <>
                （<StateDot className={styles.inlineDot} state="idle" /> 状态未知）
              </>
            ) : props.keyConfigured ? (
              <>
                （<StateDot className={styles.inlineDot} state="done" /> 已配置）
              </>
            ) : (
              <>
                （<StateDot className={styles.inlineDot} state="warning" /> 未配置）
              </>
            )}
            。密钥只写存入 credentials，settings.yaml 里只保留引用名；与保存一起提交。
          </p>
          {!route.declared ? (
            <label className={styles.check}>
              <Switch
                checked={useBuiltin}
                disabled={props.busy}
                onChange={toggleUseBuiltin}
                label="使用内置配置"
              />
              使用内置配置
              <span className={styles.hintInline}>
                清除显示名、协议、Endpoint 与模型等全部自定义，仅保留 API Key
              </span>
            </label>
          ) : null}
        </section>

        {useBuiltin ? null : (
          <>
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>连接</h3>
              <div className={styles.grid}>
                <TextField
                  label="显示名"
                  value={providerDraft.displayName}
                  disabled={props.busy}
                  placeholder={route.displayName || route.provider}
                  onChange={(value) => setProviderDraft({ ...providerDraft, displayName: value })}
                />
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
                <TextField
                  label="Endpoint（baseURL）"
                  wide
                  value={providerDraft.baseURL}
                  disabled={props.busy}
                  placeholder={route.baseURL ?? 'https://gateway.example/v1'}
                  onChange={(value) => setProviderDraft({ ...providerDraft, baseURL: value })}
                />
              </div>
              <p className={styles.hint}>
                API 协议留空 = 继承安装目录 / 上一层的协议（pi-ai 不做自动判断）；显式设置 Endpoint
                会覆盖默认地址（自定义网关常用）。推理参数格式在下方各模型的 compat 里设置。
              </p>
            </section>

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>模型（{rows.length}）</h3>
              {rows.length > 0 ? (
                <div className={styles.list}>
                  <ModelTable
                    rows={rows.map((row) => {
                      const entry: PiAiModelEntry | undefined = row.userEntry ?? row.catalogEntry
                      const rowFacts = factsOf(row.id)
                      // 与列表页同一条回退链：条目 → 生效桥 → route 默认，避免
                      // 未显式配置的容量显示成 —。
                      const panelRow = rowOf(row.id)
                      return {
                        key: row.id,
                        name: row.name,
                        id: row.id,
                        badge: draftRowLabel(draftSource, row),
                        ctx:
                          entry?.contextWindow ?? rowFacts?.contextWindow ?? panelRow?.effectiveContextWindow,
                        out: entry?.maxTokens ?? rowFacts?.defaultMaxTokens ?? panelRow?.effectiveMaxTokens,
                        input: entry?.input ?? rowFacts?.inputModalities,
                        reasoning: entry === undefined ? '默认' : effortsLabel(entry),
                        onClick: () => switchModelEdit({ creating: false, row }),
                        actions: (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={props.busy}
                            // 只改草稿，保存时才真正写入：无需二次确认。
                            onClick={() => removeModel(row)}
                          >
                            删除
                          </Button>
                        ),
                      }
                    })}
                    onReorder={
                      draftSource === 'explicit' || draftSource === 'declared' ? reorderModel : undefined
                    }
                  />
                </div>
              ) : (
                <div className={styles.empty}>
                  {route.declared ? '手写 route 至少需要一个模型' : '没有用户层模型配置，全部继承安装目录'}
                </div>
              )}
              {modelEdit !== undefined ? (
                <ModelForm
                  key={`${modelEdit.creating ? 'add' : 'edit'}:${modelEdit.row.id}`}
                  row={modelEdit.row}
                  creating={modelEdit.creating}
                  existingRows={
                    modelEdit.creating
                      ? rows.filter((row) => row.id !== formAppliedIdRef.current)
                      : rows.filter((row) => row.id !== modelEdit.row.id)
                  }
                  facts={modelEdit.creating ? undefined : factsOf(modelEdit.row.id)}
                  routeDefaults={routeDefaults}
                  catalogIds={route.declared ? undefined : catalogIds}
                  busy={props.busy}
                  onCancel={() => switchModelEdit(undefined)}
                  onChange={applyModelLive}
                />
              ) : (
                <>
                  <div className={styles.toolbar}>
                    <Button
                      variant="outline"
                      icon={<IconPlusOutlineRegular />}
                      disabled={props.busy}
                      onClick={() => switchModelEdit({ creating: true, row: BLANK_ROW })}
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
                </>
              )}
            </section>
          </>
        )}
      </div>

      {confirm !== undefined ? (
        <ConfirmDialog
          title={
            confirm.kind === 'delete'
              ? `删除 Provider ${route.provider}`
              : confirm.kind === 'reset'
                ? '恢复目录继承'
                : '放弃未保存的修改？'
          }
          body={
            confirm.kind === 'delete'
              ? '只删除 llm-pi-ai 用户层里的这条 profile（凭据与组合层配置保留）。未保存的修改将一并丢弃。'
              : confirm.kind === 'reset'
                ? '将清空用户层的 models 与 modelOverrides（连接字段保留）；草稿立即反映，保存后生效。'
                : '有未保存的修改，离开将丢弃。'
          }
          confirmLabel={confirm.kind === 'delete' ? '删除' : '确定'}
          busy={props.busy}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            const target = confirm
            setConfirm(undefined)
            if (target.kind === 'leave') props.onExit()
            else if (target.kind === 'reset') {
              setDraftProfile(resetToCatalog(draftProfile))
              setModelEdit(undefined)
            } else props.onDelete()
          }}
        />
      ) : null}
    </Modal>
  )
}
