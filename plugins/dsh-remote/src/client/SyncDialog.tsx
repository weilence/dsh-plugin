import { useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Dialog, IssueList, PickList, SelectField, type PickItem } from '@dsh-plugins/client-ui'
import { errMsg } from '@dsh-plugins/shared'
import {
  mcpStatus,
  pluginStatus,
  skillStatus,
  type ConnRow,
  type ItemStatus,
  type LocalRowsResponse,
  type RegistryPluginInstall,
  type RemoteInventoryResponse,
  type SyncKind,
} from '../shared'
import { remoteApi } from './api'
import type { RemoteStore } from './store'
import local from './RemoteForm.module.css'

const KIND_TITLES: Record<SyncKind, string> = { skills: 'Skills', mcp: 'MCP', plugins: '插件' }
// 与卡片同步下拉菜单的三个入口同词，避免「同步 skills」点开变「同步Skills」
const KIND_ACTION_LABELS: Record<SyncKind, string> = {
  skills: '同步 skills',
  mcp: '同步 MCP',
  plugins: '同步插件',
}

const KIND_DESCRIPTIONS: Record<SyncKind, string> = {
  skills:
    '列表为本机两个用户级根的技能：勾选项推送到远端（已一致的自动跳过）；未勾选与远端独有条目不受影响，不会删除远端内容。',
  mcp: '列表为本机两层 patch 的 MCP 声明：勾选项写入远端（已一致的自动跳过）；未勾选与远端独有条目不受影响，不会删除远端内容。',
  plugins:
    '列表为本机已装插件：勾选项安装 / 升级到远端（已一致的自动跳过）；未勾选与远端独有条目不受影响，不会删除远端内容。',
}

/** same 不占状态标签位（它由锁定勾选 + 汇总行表达），其余三态一类一套措辞。 */
const STATUS_LABELS: Record<SyncKind, Record<Exclude<ItemStatus, 'same'>, string>> = {
  skills: { diff: '内容不同', absent: '远端没有', unknown: '无法比对' },
  mcp: { diff: '配置不同', absent: '远端没有', unknown: '无法比对' },
  plugins: { diff: '版本不同', absent: '远端未激活', unknown: '无法比对' },
}

interface DraftState {
  skillNames: Set<string>
  mcpServerNames: Set<string>
  pluginNames: Set<string>
  registryPluginInstall: RegistryPluginInstall
}

/** 勾选不持久化：初始空集——打开弹窗看到的是待决策清单，默认不勾选任何项。 */
function initialDraft(): DraftState {
  return {
    skillNames: new Set(),
    mcpServerNames: new Set(),
    pluginNames: new Set(),
    registryPluginInstall: 'remote',
  }
}

/** 一行的判定结论 + 渲染物料（status 与引擎执行时的判定同源同函数）。 */
interface SyncRow {
  key: string
  status: ItemStatus
  item: PickItem
}

function statusLabel(kind: SyncKind, status: ItemStatus): string {
  return status === 'same' ? '已一致' : STATUS_LABELS[kind][status]
}

/** 本机清单 × 远端事实 → 本类全部行的判定（清单不可比对时由调用方拦截）。 */
function rowsOf(
  kind: SyncKind,
  localRows: LocalRowsResponse,
  inventory: RemoteInventoryResponse | null,
): SyncRow[] {
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
        item: {
          key: skill.name,
          title: skill.name,
          titleMeta: [
            skill.root === 'user-dsh' ? '~/.dsh/skills' : '~/.agents/skills',
            statusLabel(kind, status),
          ].join(' · '),
          lines: skill.description === null ? [] : [skill.description],
        },
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
        item: {
          key: entry.serverName ?? entry.id,
          title: entry.serverName ?? entry.id,
          titleMeta: entry.id,
          lines: [
            entry.summary,
            ...(status === 'diff' && fact !== undefined ? [`远端：${fact.summary}`] : []),
          ],
        },
      }
    })
  }
  return localRows.pluginRows.map((plugin) => {
    const facts = inventory?.plugins
    const fact = facts?.find((item) => item.name === plugin.name)
    const status: ItemStatus =
      facts === undefined || facts === null ? 'unknown' : pluginStatus(plugin.version, fact)
    const remote =
      fact === undefined
        ? statusLabel(kind, status)
        : fact.version === null
          ? '远端已激活（版本未知）'
          : `远端 v${fact.version}`
    return {
      key: plugin.name,
      status,
      item: {
        key: plugin.name,
        title: plugin.name,
        titleMeta: [
          `${plugin.source === 'profile' ? 'profile 层' : 'home 层'} · ${
            plugin.install === 'local' ? '本地' : 'npm'
          }${plugin.version === null ? '' : ` · v${plugin.version}`}`,
          status === 'same' ? statusLabel(kind, status) : `${statusLabel(kind, status)} · ${remote}`,
        ].join(' · '),
      },
    }
  })
}

export function SyncDialog(props: {
  row: ConnRow
  kind: SyncKind
  store: RemoteStore
  localRows: LocalRowsResponse | null
  busy: boolean
  onClose(): void
}) {
  const { row, kind, localRows } = props
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
  // same 沉底：变化项在前（错误降级时全 unknown，顺序即本机清单顺序）
  const rows = useMemo(() => {
    if (unavailable || localRows === null || !settled) return []
    const all = rowsOf(kind, localRows, inventory)
    return [
      ...all.filter((entry) => entry.status !== 'same'),
      ...all.filter((entry) => entry.status === 'same'),
    ]
  }, [kind, localRows, inventory, settled, unavailable])

  const statusOfKey = useMemo(() => new Map(rows.map((entry) => [entry.key, entry.status])), [rows])
  const pickedOfKind =
    kind === 'skills' ? draft.skillNames : kind === 'mcp' ? draft.mcpServerNames : draft.pluginNames

  // 判定就绪后把一致项锁定进勾选集（恒在提交名单——引擎对其无操作）；
  // 非 same 项保持初始不勾选，由用户逐项决定。
  useEffect(() => {
    if (rows.length === 0) return
    const sameKeys = rows.filter((entry) => entry.status === 'same').map((entry) => entry.key)
    if (sameKeys.length === 0) return
    setDraft((previous) => {
      const merged = new Set([...pickedSetOf(kind, previous), ...sameKeys])
      return kind === 'skills'
        ? { ...previous, skillNames: merged }
        : kind === 'mcp'
          ? { ...previous, mcpServerNames: merged }
          : { ...previous, pluginNames: merged }
    })
  }, [rows, kind])

  const toggle = (key: string): void => {
    // 一致项锁定勾选（PickList 已禁用其 checkbox，这里双保险）
    if (statusOfKey.get(key) === 'same') return
    const next = new Set(pickedOfKind)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    patch(
      kind === 'skills'
        ? { skillNames: next }
        : kind === 'mcp'
          ? { mcpServerNames: next }
          : { pluginNames: next },
    )
  }

  const counts = useMemo(() => {
    const tally: Record<ItemStatus, number> = { same: 0, diff: 0, absent: 0, unknown: 0 }
    for (const entry of rows) tally[entry.status] += 1
    return tally
  }, [rows])

  // 纯 same 提交是无操作：提交按钮要求至少勾选一个非 same 项
  const anyActionable = [...pickedOfKind].some((key) => statusOfKey.get(key) !== 'same')

  const submit = async (): Promise<void> => {
    const names = [...pickedOfKind]
    // 勾选随请求直传引擎执行（失败面板错误行可见），不落中间保存
    await props.store.sync(row.id, kind, names, kind === 'plugins' ? draft.registryPluginInstall : undefined)
    props.onClose()
  }

  const summaryParts = [
    counts.diff > 0 ? `${counts.diff} 项${STATUS_LABELS[kind].diff}` : null,
    counts.absent > 0 ? `${counts.absent} 项${STATUS_LABELS[kind].absent}` : null,
    counts.unknown > 0 ? `${counts.unknown} 项${STATUS_LABELS[kind].unknown}` : null,
    counts.same > 0 ? `${counts.same} 项已一致（${hideSame ? '已隐藏' : '下方锁定勾选'}）` : null,
  ].filter((part): part is string => part !== null)

  const visibleRows = hideSame ? rows.filter((entry) => entry.status !== 'same') : rows

  return (
    <Dialog
      title={`同步到「${row.label}」：${KIND_TITLES[kind]}`}
      description={KIND_DESCRIPTIONS[kind]}
      onClose={props.onClose}
      size="lg"
      actions={
        <>
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={props.busy || unavailable || inventoryState === 'loading' || !anyActionable}
            onClick={() => void submit()}
          >
            {props.busy ? '同步中…' : KIND_ACTION_LABELS[kind]}
          </Button>
        </>
      }
    >
      {unavailable ? (
        <p className={local.hint}>本机清单不可用（当前宿主未提供 profileContext），无法选择同步内容。</p>
      ) : inventoryState === 'loading' ? (
        /* 远端清单就绪前不渲染列表：避免先短暂渲染无判定状态、就绪后再跳变 */
        <p className={local.hint}>正在读取远端清单并与本机比对…</p>
      ) : (
        <div className={local.formBody}>
          {inventoryState === 'error' ? (
            <IssueList
              issues={[
                {
                  message: `远端清单读取失败（${inventoryError ?? '未知原因'}；宿主为旧版时重启宿主可解）：无法逐条比对，以下按「无法比对」展示；确认后将按勾选推送 / 覆盖（只新增 / 覆盖，不删除远端内容）。`,
                },
              ]}
            />
          ) : null}
          {kind === 'plugins' ? (
            <p className={local.hint}>
              本地路径安装（link / file）的插件永远本地打包传输；npm 依赖形态按下面的选项。
            </p>
          ) : null}
          {kind === 'plugins' ? (
            <SelectField
              label="非本地插件安装方式"
              value={draft.registryPluginInstall}
              options={[
                { value: 'remote', label: '远端下载（远端 npm 拉取，需已发布）' },
                { value: 'push', label: '本地传输（打包本机实体推送，无需发布）' },
              ]}
              onChange={(registryPluginInstall) => patch({ registryPluginInstall })}
            />
          ) : null}
          {rows.length === 0 ? (
            <p className={local.hint}>
              {kind === 'skills'
                ? '本机两个用户级根（~/.dsh/skills、~/.agents/skills）没有可发现的技能。'
                : kind === 'mcp'
                  ? '本机没有可同步的 MCP 声明。'
                  : '本机没有可同步的插件（两层 patch 行与 bundles 激活清单均为空）。'}
            </p>
          ) : (
            <>
              <p className={local.hint}>{summaryParts.join(' · ')}——勾选才会同步，默认全部不勾。</p>
              <label className={local.hideToggle}>
                <input
                  type="checkbox"
                  checked={hideSame}
                  onChange={(event) => setHideSame(event.target.checked)}
                />
                隐藏已一致条目（{counts.same}）
              </label>
              <PickList
                items={visibleRows.map((entry) => ({ ...entry.item, locked: entry.status === 'same' }))}
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

/** 当前类别在草稿里的勾选集（锁定合并用，读当前态而非渲染缓存）。 */
function pickedSetOf(kind: SyncKind, draft: DraftState): Set<string> {
  return kind === 'skills' ? draft.skillNames : kind === 'mcp' ? draft.mcpServerNames : draft.pluginNames
}
