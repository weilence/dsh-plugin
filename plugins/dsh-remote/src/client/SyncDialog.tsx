/**
 * 同步弹窗：三类同步（skills / MCP / 插件）的唯一入口——勾选即连接的同步
 * 清单（保存时写回 connection.sync），确认后一次同步全部。插件的「非本地
 * 安装方式」选项与勾选强相关，随弹窗一起编辑。
 */

import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Dialog, IssueList, PickList, SelectField } from '@dsh-plugins/client-ui'
import type { ConnRow, LocalRowsResponse, RegistryPluginInstall, SaveRequest } from '../shared'
import type { RemoteStore } from './store'
import local from './RemoteForm.module.css'

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
  store: RemoteStore
  localRows: LocalRowsResponse | null
  busy: boolean
  onClose(): void
}) {
  const { row, localRows } = props
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
    // 先保存勾选清单，成功后触发一次全量同步
    if (!(await props.store.save(request))) {
      setError('保存同步清单失败，未开始同步')
      return
    }
    await props.store.sync(row.id, 'all')
    props.onClose()
  }

  return (
    <Dialog
      title={`同步到「${row.label}」`}
      description="勾选要同步的内容并确认——skills 按勾选推送（取消勾选的会在远端删除）、MCP 声明整块写入远端 patch、插件按安装形态分流。"
      onClose={props.onClose}
      size="lg"
      meta={row.sshAlias}
      actions={
        <>
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={props.busy || unavailable} onClick={() => void submit()}>
            {props.busy ? '同步中…' : '同步'}
          </Button>
        </>
      }
    >
      {unavailable ? (
        <p className={local.hint}>本机清单不可用（当前宿主未提供 profileContext），无法选择同步内容。</p>
      ) : (
        <div className={local.formBody}>
          <section className={local.section}>
            <h4 className={local.sectionTitle}>Skills</h4>
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

          <section className={local.section}>
            <h4 className={local.sectionTitle}>MCP 下发</h4>
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

          <section className={local.section}>
            <h4 className={local.sectionTitle}>插件</h4>
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

          {error !== null ? <IssueList issues={[{ message: error }]} /> : null}
        </div>
      )}
    </Dialog>
  )
}
