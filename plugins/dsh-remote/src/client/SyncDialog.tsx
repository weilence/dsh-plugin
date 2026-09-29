/**
 * 同步弹窗：从「同步」下拉菜单选定类别后打开，列表 = 本机该类清单，默认
 * 勾选 = 远端已有（打开时经 POST remote-inventory 实时读取；条目级差异
 * 对比的判定后续迭代）。确认即把勾选随 POST /sync 直传远端执行：勾选项
 * 安装/升级、未勾选且远端已有的删除——不落任何中间保存。
 */

import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Dialog, IssueList, PickList, SelectField } from '@dsh-plugins/client-ui'
import { errMsg } from '@dsh-plugins/shared'
import type { ConnRow, LocalRowsResponse, RegistryPluginInstall, RemoteInventoryResponse } from '../shared'
import { remoteApi } from './api'
import type { RemoteStore } from './store'
import local from './RemoteForm.module.css'

/** 弹窗可编辑的类别（下拉菜单的三项）。 */
export type DialogKind = 'skills' | 'mcp' | 'plugins'

const KIND_TITLES: Record<DialogKind, string> = { skills: 'Skills', mcp: 'MCP', plugins: '插件' }

interface DraftState {
  skillNames: Set<string>
  mcpServerNames: Set<string>
  pluginNames: Set<string>
  registryPluginInstall: RegistryPluginInstall
}

/** 勾选不持久化：初始空集，远端清单就绪后填默认（本机 ∩ 远端）。 */
function initialDraft(): DraftState {
  return {
    skillNames: new Set(),
    mcpServerNames: new Set(),
    pluginNames: new Set(),
    registryPluginInstall: 'remote',
  }
}

/** 本机清单的勾选键（skills 用技能名、MCP 用 serverName、插件用包名）。 */
function localKeysOf(kind: DialogKind, localRows: LocalRowsResponse): string[] {
  if (kind === 'skills') return localRows.skillRows.map((skill) => skill.name)
  if (kind === 'mcp') return localRows.mcpRows.map((entry) => entry.serverName ?? entry.id)
  return localRows.pluginRows.map((plugin) => plugin.name)
}

export function SyncDialog(props: {
  row: ConnRow
  kind: DialogKind
  store: RemoteStore
  localRows: LocalRowsResponse | null
  busy: boolean
  onClose(): void
}) {
  const { row, kind, localRows } = props
  const [draft, setDraft] = useState<DraftState>(initialDraft)
  // 远端清单：默认勾选源。读取期间不渲染列表（提交禁用）；读取失败同样禁用
  // 提交——声明式语义下「未勾选且远端已有=删除」，没有远端事实绝不执行。
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

  // 清单就绪后把本类默认勾选替换为「本机 ∩ 远端」
  useEffect(() => {
    if (inventoryState !== 'ready' || inventory === null || unavailable || localRows === null) return
    const remote = new Set(
      kind === 'skills' ? inventory.skills : kind === 'mcp' ? inventory.mcp : inventory.plugins,
    )
    const picked = new Set(localKeysOf(kind, localRows).filter((key) => remote.has(key)))
    setDraft((previous) =>
      kind === 'skills'
        ? { ...previous, skillNames: picked }
        : kind === 'mcp'
          ? { ...previous, mcpServerNames: picked }
          : { ...previous, pluginNames: picked },
    )
  }, [inventoryState, inventory, kind, localRows, unavailable])

  const submit = async (): Promise<void> => {
    const names =
      kind === 'skills'
        ? [...draft.skillNames]
        : kind === 'mcp'
          ? [...draft.mcpServerNames]
          : [...draft.pluginNames]
    // 勾选随请求直传引擎执行（失败面板错误行可见），不落中间保存
    await props.store.sync(row.id, kind, names, kind === 'plugins' ? draft.registryPluginInstall : undefined)
    props.onClose()
  }

  return (
    <Dialog
      title={`同步到「${row.label}」：${KIND_TITLES[kind]}`}
      description={
        kind === 'skills'
          ? '列表为本机两个用户级根的技能，默认勾选远端已有的——确认后推送勾选项、删除远端已有但未勾选的。'
          : kind === 'mcp'
            ? '列表为本机两层 patch 的 MCP 声明，默认勾选远端已有的——确认后写入勾选项、移除远端已有但未勾选的。'
            : '列表为本机已装插件，默认勾选远端已有的——确认后安装/升级勾选项、移除远端已有但未勾选的。'
      }
      onClose={props.onClose}
      size="lg"
      actions={
        <>
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={props.busy || unavailable || inventoryState !== 'ready'}
            onClick={() => void submit()}
          >
            {props.busy ? '同步中…' : `同步${KIND_TITLES[kind]}`}
          </Button>
        </>
      }
    >
      {unavailable ? (
        <p className={local.hint}>本机清单不可用（当前宿主未提供 profileContext），无法选择同步内容。</p>
      ) : inventoryState === 'loading' ? (
        /* 远端清单就绪前不渲染列表：避免先闪现上次保存的勾选、就绪后再跳变 */
        <p className={local.hint}>正在读取远端清单并与本机对比（默认勾选 = 远端已有）…</p>
      ) : (
        <div className={local.formBody}>
          {inventoryState === 'error' ? (
            <IssueList
              issues={[
                {
                  message: `远端清单读取失败（${inventoryError ?? '未知原因'}；宿主为旧版时重启宿主可解）：为防误删已禁用同步，请关闭弹窗重试。`,
                },
              ]}
            />
          ) : null}
          {kind === 'skills' ? (
            <section className={local.section}>
              {localRows.skillRows.length === 0 ? (
                <p className={local.hint}>
                  本机两个用户级根（~/.dsh/skills、~/.agents/skills）没有可发现的技能。
                </p>
              ) : (
                <PickList
                  items={localRows.skillRows.map((skill) => ({
                    key: skill.name,
                    title: skill.name,
                    titleMeta: skill.root === 'user-dsh' ? '~/.dsh/skills' : '~/.agents/skills',
                    lines: skill.description === null ? [] : [skill.description],
                  }))}
                  picked={draft.skillNames}
                  onToggle={(key) => {
                    const next = new Set(draft.skillNames)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    patch({ skillNames: next })
                  }}
                />
              )}
            </section>
          ) : null}

          {kind === 'mcp' ? (
            <section className={local.section}>
              {localRows.mcpRows.length === 0 ? (
                <p className={local.hint}>本机没有可同步的 MCP 声明。</p>
              ) : (
                <PickList
                  items={localRows.mcpRows.map((entry) => ({
                    key: entry.serverName ?? entry.id,
                    title: entry.serverName ?? entry.id,
                    titleMeta: entry.id,
                    lines: [entry.summary],
                  }))}
                  picked={draft.mcpServerNames}
                  onToggle={(key) => {
                    const next = new Set(draft.mcpServerNames)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    patch({ mcpServerNames: next })
                  }}
                />
              )}
            </section>
          ) : null}

          {kind === 'plugins' ? (
            <section className={local.section}>
              <p className={local.hint}>
                本地路径安装（link / file）的插件永远本地打包传输；npm 依赖形态按下面的选项。
              </p>
              <SelectField
                label="非本地插件安装方式"
                value={draft.registryPluginInstall}
                options={[
                  { value: 'remote', label: '远端下载（远端 npm 拉取，需已发布）' },
                  { value: 'push', label: '本地传输（打包本机实体推送，无需发布）' },
                ]}
                onChange={(value) => patch({ registryPluginInstall: value as RegistryPluginInstall })}
              />
              {localRows.pluginRows.length === 0 ? (
                <p className={local.hint}>本机没有可同步的插件（两层 patch 行与 bundles 激活清单均为空）。</p>
              ) : (
                <PickList
                  items={localRows.pluginRows.map((plugin) => ({
                    key: plugin.name,
                    title: plugin.name,
                    titleMeta: `${plugin.source === 'profile' ? 'profile 层' : 'home 层'} · ${
                      plugin.install === 'local' ? '本地' : 'npm'
                    }${plugin.version === null ? '' : ` · v${plugin.version}`}`,
                  }))}
                  picked={draft.pluginNames}
                  onToggle={(key) => {
                    const next = new Set(draft.pluginNames)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    patch({ pluginNames: next })
                  }}
                />
              )}
            </section>
          ) : null}
        </div>
      )}
    </Dialog>
  )
}
