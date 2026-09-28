/**
 * 同步弹窗：从「同步」下拉菜单选定类别后打开，只编辑该类别的勾选清单
 * （保存时写回 connection.sync），确认后同步该类。skills 按勾选推送、
 * MCP 声明整块写入远端 patch、插件按安装形态分流（选项随插件弹窗编辑）。
 */

import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Dialog, IssueList, PickList, SelectField } from '@dsh-plugins/client-ui'
import type { ConnRow, LocalRowsResponse, RegistryPluginInstall, SaveRequest } from '../shared'
import type { RemoteStore } from './store'
import local from './RemoteForm.module.css'

/** 弹窗可编辑的类别（下拉菜单的三项；all 走按钮直发不经弹窗）。 */
export type DialogKind = 'skills' | 'mcp' | 'plugins'

const KIND_TITLES: Record<DialogKind, string> = { skills: 'Skills', mcp: 'MCP 下发', plugins: '插件' }

interface DraftState {
  skillNames: Set<string>
  mcpServerNames: Set<string>
  pluginNames: Set<string>
  registryPluginInstall: RegistryPluginInstall
}

function initialDraft(row: ConnRow): DraftState {
  return {
    skillNames: new Set(row.sync.skillNames),
    mcpServerNames: new Set(row.sync.mcpServerNames),
    pluginNames: new Set(row.sync.pluginNames),
    registryPluginInstall: row.sync.registryPluginInstall,
  }
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
  const [draft, setDraft] = useState<DraftState>(() => initialDraft(row))
  const [error, setError] = useState<string | null>(null)
  const patch = (partial: Partial<DraftState>): void => setDraft((previous) => ({ ...previous, ...partial }))

  const unavailable = localRows === null || !localRows.available
  const submit = async (): Promise<void> => {
    const request: SaveRequest = {
      id: row.id,
      label: row.label,
      sshAlias: row.sshAlias,
      sync: {
        skillNames: [...draft.skillNames],
        mcpServerNames: [...draft.mcpServerNames],
        pluginNames: [...draft.pluginNames],
        registryPluginInstall: draft.registryPluginInstall,
      },
    }
    // 先保存勾选清单，成功后同步本弹窗选定的类别
    if (!(await props.store.save(request))) {
      setError('保存同步清单失败，未开始同步')
      return
    }
    await props.store.sync(row.id, kind)
    props.onClose()
  }

  return (
    <Dialog
      title={`同步到「${row.label}」：${KIND_TITLES[kind]}`}
      description={
        kind === 'skills'
          ? '勾选要推送的技能——按勾选打包推送，取消勾选的会在远端删除。'
          : kind === 'mcp'
            ? '勾选要下发的 MCP 服务器声明（含 env 凭据），整块写入远端 profile 的 cordis.patch.yml。'
            : '勾选要同步的插件——本地路径安装恒本地打包传输，npm 依赖形态按下方选项分流。'
      }
      onClose={props.onClose}
      size="lg"
      actions={
        <>
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={props.busy || unavailable} onClick={() => void submit()}>
            {props.busy ? '同步中…' : `同步${KIND_TITLES[kind]}`}
          </Button>
        </>
      }
    >
      {unavailable ? (
        <p className={local.hint}>本机清单不可用（当前宿主未提供 profileContext），无法选择同步内容。</p>
      ) : (
        <div className={local.formBody}>
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
                <p className={local.hint}>本机没有可下发的 MCP 声明。</p>
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
                <p className={local.hint}>本机没有可同步的插件（两层用户 patch 里没有插件 insert 行）。</p>
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

          {error !== null ? <IssueList issues={[{ message: error }]} /> : null}
        </div>
      )}
    </Dialog>
  )
}
