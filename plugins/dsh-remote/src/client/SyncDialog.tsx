import { useEffect, useMemo, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { Dialog, IssueList, PickList, SelectField, type PickItem } from '@dsh-plugins/client-ui'
import { errMsg } from '@dsh-plugins/shared'
import {
  mcpStatus,
  pluginStatus,
  promptStatus,
  skillStatus,
  type ConnRow,
  type ItemStatus,
  type LocalRowsResponse,
  type RegistryPluginInstall,
  type RemoteInventoryResponse,
  type SyncKind,
} from '../shared'
import type { RemoteKey, RemoteT } from './locales'
import { remoteApi } from './api'
import type { RemoteStore } from './store'
import local from './RemoteForm.module.css'

// 与卡片同步下拉菜单的四个入口同词（op.sync-*），避免点开后措辞跳变
const KIND_ACTION_KEYS: Record<SyncKind, RemoteKey> = {
  skills: 'op.sync-skills',
  mcp: 'op.sync-mcp',
  plugins: 'op.sync-plugins',
  prompts: 'op.sync-prompts',
}

const KIND_KEYS: Record<SyncKind, RemoteKey> = {
  skills: 'kind.skills',
  mcp: 'kind.mcp',
  plugins: 'kind.plugins',
  prompts: 'kind.prompts',
}

const KIND_DESCRIPTION_KEYS: Record<SyncKind, RemoteKey> = {
  skills: 'sync.desc.skills',
  mcp: 'sync.desc.mcp',
  plugins: 'sync.desc.plugins',
  prompts: 'sync.desc.prompts',
}

/** 弹窗空态说明按类别取键（无可同步不进引擎）。 */
const KIND_EMPTY_KEYS: Record<SyncKind, RemoteKey> = {
  skills: 'sync.empty.skills',
  mcp: 'sync.empty.mcp',
  plugins: 'sync.empty.plugins',
  prompts: 'sync.empty.prompts',
}

/** same 不占状态标签位（它由行尾 ok 徽标 + 汇总行表达），其余三态一类一套措辞。 */
const STATUS_KEYS: Record<SyncKind, Record<Exclude<ItemStatus, 'same'>, RemoteKey>> = {
  skills: { diff: 'status.skills.diff', absent: 'status.skills.absent', unknown: 'status.skills.unknown' },
  mcp: { diff: 'status.mcp.diff', absent: 'status.mcp.absent', unknown: 'status.mcp.unknown' },
  // 插件比版本号（npm 语义：版本即内容契约）
  plugins: {
    diff: 'status.plugins.diff',
    absent: 'status.plugins.absent',
    unknown: 'status.plugins.unknown',
  },
  prompts: {
    diff: 'status.prompts.diff',
    absent: 'status.prompts.absent',
    unknown: 'status.prompts.unknown',
  },
}

interface DraftState {
  skillNames: Set<string>
  mcpServerNames: Set<string>
  pluginNames: Set<string>
  /** 提示词是单文件：集合只含 AGENTS.md 一个键。 */
  promptNames: Set<string>
  registryPluginInstall: RegistryPluginInstall
}

/** 勾选不持久化：初始空集——打开弹窗看到的是待决策清单，默认不勾选任何项。 */
function initialDraft(): DraftState {
  return {
    skillNames: new Set(),
    mcpServerNames: new Set(),
    pluginNames: new Set(),
    promptNames: new Set(),
    registryPluginInstall: 'remote',
  }
}

/** 一行的判定结论 + 渲染物料（status 与引擎执行时的判定同源同函数）。文本经
 *  view 描述子在渲染期取词：判定可 memo，措辞随宿主语言保持新鲜。 */
export interface SyncRow {
  key: string
  status: ItemStatus
  view(t: RemoteT): PickItem
}

function statusLabel(kind: SyncKind, status: ItemStatus, t: RemoteT): string {
  return status === 'same' ? t('status.same') : t(STATUS_KEYS[kind][status])
}

/** 本机清单 × 远端事实 → 本类全部行的判定（清单不可比对时由调用方拦截）。
 *  插件行比对版本号——与引擎执行时的判定同源同函数。名称 / 路径 / 版本号等
 *  是事实原样，只有措辞走词典。 */
export function rowsOf(
  kind: SyncKind,
  localRows: LocalRowsResponse,
  inventory: RemoteInventoryResponse | null,
): SyncRow[] {
  if (kind === 'prompts') {
    const prompt = localRows.promptRow
    // 本机没有 AGENTS.md：空列表，弹窗空态说明（无可同步不进引擎）
    if (prompt.digest === null) return []
    const status = promptStatus(prompt.digest, inventory?.prompts ?? null)
    return [
      {
        key: 'AGENTS.md',
        status,
        view: (t) => ({
          key: 'AGENTS.md',
          title: 'AGENTS.md',
          ...(status === 'same' ? { tag: t('status.same') } : { titleMeta: statusLabel(kind, status, t) }),
          lines: [prompt.path],
        }),
      },
    ]
  }
  if (kind === 'skills') {
    return localRows.skillRows.map((skill) => {
      const facts = inventory?.skills[skill.root]
      const status: ItemStatus =
        facts === undefined || facts === null
          ? 'unknown'
          : skillStatus(
              skill.digest,
              facts.find((fact) => fact.name === skill.name),
            )
      return {
        key: skill.name,
        status,
        view: (t) => ({
          key: skill.name,
          title: skill.name,
          titleMeta: [
            skill.root === 'user-dsh' ? '~/.dsh/skills' : '~/.agents/skills',
            status === 'same' ? null : statusLabel(kind, status, t),
          ].join(' · '),
          ...(status === 'same' ? { tag: t('status.same') } : {}),
          lines: skill.description === null ? [] : [skill.description],
        }),
      }
    })
  }
  if (kind === 'mcp') {
    return localRows.mcpRows.map((entry) => {
      const facts = inventory?.mcp
      const fact =
        entry.serverName === null ? undefined : facts?.find((item) => item.serverName === entry.serverName)
      const status: ItemStatus =
        facts === undefined || facts === null ? 'unknown' : mcpStatus(entry.signature, fact)
      return {
        key: entry.serverName ?? entry.id,
        status,
        view: (t) => ({
          key: entry.serverName ?? entry.id,
          title: entry.serverName ?? entry.id,
          titleMeta: entry.id,
          ...(status === 'same' ? { tag: t('status.same') } : {}),
          lines: [
            entry.summary,
            ...(status === 'diff' && fact !== undefined
              ? [t('sync.remoteMcp', { summary: fact.summary })]
              : []),
          ],
        }),
      }
    })
  }
  return localRows.pluginRows.map((plugin) => {
    const facts = inventory?.plugins
    const fact = facts?.find((item) => item.name === plugin.name)
    const status: ItemStatus =
      facts === undefined || facts === null ? 'unknown' : pluginStatus(plugin.version, fact?.version)
    return {
      key: plugin.name,
      status,
      view: (t) => {
        // same 行由行尾徽标表达状态：titleMeta 留事实（层级 / 形态 / 版本），
        // 不再缀「已一致 · 远端 v…」（版本相等时是重复信息）
        const remote =
          status === 'same' || fact === undefined
            ? null
            : fact.version === null
              ? t('plugin.remoteActiveUnknown')
              : t('plugin.remoteVersion', { version: fact.version })
        return {
          key: plugin.name,
          title: plugin.name,
          titleMeta: [
            `${t(plugin.source === 'profile' ? 'plugin.source.profile' : 'plugin.source.home')} · ${t(
              plugin.install === 'local' ? 'plugin.install.local' : 'plugin.install.registry',
            )}${plugin.version === null ? '' : ` · v${plugin.version}`}`,
            status === 'same'
              ? null
              : [statusLabel(kind, status, t), remote].filter((part) => part !== null).join(' · '),
          ]
            .filter((part) => part !== null)
            .join(' · '),
          ...(status === 'same' ? { tag: t('status.same') } : {}),
        }
      },
    }
  })
}

export function SyncDialog(props: {
  row: ConnRow
  kind: SyncKind
  store: RemoteStore
  t: RemoteT
  localRows: LocalRowsResponse | null
  busy: boolean
  onClose(): void
}) {
  const { row, kind, localRows, t } = props
  const [draft, setDraft] = useState<DraftState>(initialDraft)
  // 一致项默认隐藏：弹窗打开只见将发生变化的条目；开关纯视图，不改变提交集
  const [hideSame, setHideSame] = useState(true)
  // 远端事实：行级徽标的判定源。读取期间不渲染列表（提交禁用）；读取失败降级
  // 为「无法比对」渲染——同步只新增/覆盖，无删除风险，不阻断。
  const [inventory, setInventory] = useState<RemoteInventoryResponse | null>(null)
  const [inventoryState, setInventoryState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [inventoryError, setInventoryError] = useState<string | null>(null)
  const patch = (partial: Partial<DraftState>): void => setDraft((previous) => ({ ...previous, ...partial }))

  const unavailable = localRows === null || !localRows.available

  useEffect(() => {
    let alive = true
    setInventory(null)
    setInventoryError(null)
    setInventoryState('loading')
    remoteApi.remoteInventory(row.id).then(
      (data) => {
        if (!alive) return
        setInventory(data)
        setInventoryState('ready')
      },
      (reason: unknown) => {
        if (!alive) return
        setInventoryError(errMsg(reason))
        setInventoryState('error')
      },
    )
    return () => {
      alive = false
    }
  }, [row.id])

  const settled = inventoryState === 'ready' || inventoryState === 'error'
  // same 沉底：变化项在前（错误降级时全 unknown，顺序即本机清单顺序）。
  // 判定可 memo（同一事实集），措辞在渲染期经 view(t) 现取。
  const rows = useMemo(() => {
    if (unavailable || localRows === null || !settled) return []
    const all = rowsOf(kind, localRows, inventory)
    return [
      ...all.filter((entry) => entry.status !== 'same'),
      ...all.filter((entry) => entry.status === 'same'),
    ]
  }, [kind, localRows, inventory, settled, unavailable])

  const pickedOfKind =
    kind === 'skills'
      ? draft.skillNames
      : kind === 'mcp'
        ? draft.mcpServerNames
        : kind === 'plugins'
          ? draft.pluginNames
          : draft.promptNames

  const toggle = (key: string): void => {
    const next = new Set(pickedOfKind)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    patch(
      kind === 'skills'
        ? { skillNames: next }
        : kind === 'mcp'
          ? { mcpServerNames: next }
          : kind === 'plugins'
            ? { pluginNames: next }
            : { promptNames: next },
    )
  }

  const counts = useMemo(() => {
    const tally: Record<ItemStatus, number> = { same: 0, diff: 0, absent: 0, unknown: 0 }
    for (const entry of rows) tally[entry.status] += 1
    return tally
  }, [rows])

  const submit = async (): Promise<void> => {
    const names = [...pickedOfKind]
    // 勾选随请求直传引擎执行（失败面板错误行可见），不落中间保存
    await props.store.sync(row.id, kind, names, kind === 'plugins' ? draft.registryPluginInstall : undefined)
    props.onClose()
  }

  const summaryParts = [
    counts.diff > 0 ? t('sync.summaryCount', { count: counts.diff, label: t(STATUS_KEYS[kind].diff) }) : null,
    counts.absent > 0
      ? t('sync.summaryCount', { count: counts.absent, label: t(STATUS_KEYS[kind].absent) })
      : null,
    counts.unknown > 0
      ? t('sync.summaryCount', { count: counts.unknown, label: t(STATUS_KEYS[kind].unknown) })
      : null,
    counts.same > 0
      ? t('sync.summarySame', { count: counts.same, state: t(hideSame ? 'sync.hidden' : 'sync.forceHint') })
      : null,
  ].filter((part): part is string => part !== null)

  const visibleRows = hideSame ? rows.filter((entry) => entry.status !== 'same') : rows
  // 全选只作用于当前可见行：强制重推已一致项是有意动作，须先取消隐藏再把
  // 它们纳入勾选，随手的全选不隐式触发重推
  const allVisiblePicked = visibleRows.length > 0 && visibleRows.every((entry) => pickedOfKind.has(entry.key))
  const toggleAll = (): void => {
    const next = new Set(pickedOfKind)
    for (const entry of visibleRows) {
      if (allVisiblePicked) next.delete(entry.key)
      else next.add(entry.key)
    }
    patch(
      kind === 'skills'
        ? { skillNames: next }
        : kind === 'mcp'
          ? { mcpServerNames: next }
          : kind === 'plugins'
            ? { pluginNames: next }
            : { promptNames: next },
    )
  }

  return (
    <Dialog
      title={t('sync.title', { label: row.label, kind: t(KIND_KEYS[kind]) })}
      description={t(KIND_DESCRIPTION_KEYS[kind])}
      closeLabel={t('close')}
      onClose={props.onClose}
      size="lg"
      actions={
        <>
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={props.busy || unavailable || inventoryState === 'loading' || pickedOfKind.size === 0}
            onClick={() => void submit()}
          >
            {props.busy ? t('sync.busy') : t(KIND_ACTION_KEYS[kind])}
          </Button>
        </>
      }
    >
      {unavailable ? (
        <p className={local.hint}>{t('sync.unavailable')}</p>
      ) : inventoryState === 'loading' ? (
        /* 远端清单就绪前不渲染列表：避免先短暂渲染无判定状态、就绪后再跳变 */
        <p className={local.hint}>{t('sync.loadingInventory')}</p>
      ) : (
        <div className={local.formBody}>
          {inventoryState === 'error' ? (
            <IssueList
              issues={[
                {
                  message: t('sync.inventoryError', {
                    reason: inventoryError ?? t('sync.unknownReason'),
                  }),
                },
              ]}
            />
          ) : null}
          {kind === 'plugins' ? <p className={local.hint}>{t('sync.pluginsHint')}</p> : null}
          {kind === 'plugins' ? (
            <SelectField
              label={t('sync.registryInstallLabel')}
              value={draft.registryPluginInstall}
              options={[
                { value: 'remote', label: t('sync.registryInstall.remote') },
                { value: 'push', label: t('sync.registryInstall.push') },
              ]}
              onChange={(registryPluginInstall) => patch({ registryPluginInstall })}
            />
          ) : null}
          {rows.length === 0 ? (
            <p className={local.hint}>{t(KIND_EMPTY_KEYS[kind])}</p>
          ) : (
            <>
              <p className={local.hint}>
                {summaryParts.join(' · ')}
                {t('sync.summarySuffix')}
              </p>
              <div className={local.syncToolbar}>
                <label className={local.checkAll}>
                  <input type="checkbox" checked={allVisiblePicked} onChange={toggleAll} />
                  {t('sync.selectAll')}
                </label>
                <span className={local.hideSameRow}>
                  <span className={local.hideSameText}>{t('sync.hideSame', { count: counts.same })}</span>
                  <Switch
                    checked={hideSame}
                    onChange={setHideSame}
                    label={t('sync.hideSame', { count: counts.same })}
                  />
                </span>
              </div>
              <PickList
                items={visibleRows.map((entry) => entry.view(t))}
                picked={pickedOfKind}
                onToggle={toggle}
              />
            </>
          )}
        </div>
      )}
    </Dialog>
  )
}
