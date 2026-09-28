/**
 * 连接表单：新建 / 编辑共用。基本信息只有 label / sshAlias——远端 profile
 * 固定 web、远端 dsh 版本部署时对齐本机，均不暴露输入。同步配置只有
 * 两份勾选清单（MCP 下发、本地插件同步）；skills 同步一律手动触发，无开关。
 * 同步能力全部收在 dsh-remote 自己的面板里——dsh-mcp / dsh-skills 不感知远端。
 */

import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { IssueList, PickList, SelectField, TextField } from '@dsh-plugins/client-ui'
import type { ConnRow, LocalRowsResponse, RegistryPluginInstall, SaveRequest } from '../shared'
import type { RemoteStore } from './store'
import local from './RemoteForm.module.css'
import shared from '@dsh-plugins/client-ui/styles'

const styles = { ...shared, ...local }

interface DraftState {
  label: string
  sshAlias: string
  mcpServerNames: Set<string>
  pluginNames: Set<string>
  registryPluginInstall: RegistryPluginInstall
}

function initialDraft(row: ConnRow | undefined): DraftState {
  return {
    label: row?.label ?? '',
    sshAlias: row?.sshAlias ?? '',
    mcpServerNames: new Set(row?.sync.mcpServerNames ?? []),
    pluginNames: new Set(row?.sync.pluginNames ?? []),
    registryPluginInstall: row?.sync.registryPluginInstall ?? 'remote',
  }
}

function validateDraft(draft: DraftState): string[] {
  const issues: string[] = []
  if (draft.label.trim().length === 0) issues.push('显示名不能为空')
  if (draft.sshAlias.trim().length === 0) issues.push('sshAlias 不能为空（~/.ssh/config 里的主机别名）')
  return issues
}

export function RemoteForm(props: {
  mode: 'create' | 'edit'
  row?: ConnRow
  store: RemoteStore
  localRows: LocalRowsResponse | null
  busy: boolean
  error: string | null
  onDone(): void
  onCancel(): void
}) {
  const [draft, setDraft] = useState<DraftState>(() => initialDraft(props.row))
  const [touched, setTouched] = useState(false)
  const issues = validateDraft(draft)
  const patch = (partial: Partial<DraftState>): void => setDraft((previous) => ({ ...previous, ...partial }))

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (issues.length > 0) return
    const request: SaveRequest = {
      ...(props.mode === 'edit' && props.row !== undefined ? { id: props.row.id } : {}),
      label: draft.label.trim(),
      sshAlias: draft.sshAlias.trim(),
      sync: {
        mcpServerNames: [...draft.mcpServerNames],
        pluginNames: [...draft.pluginNames],
        registryPluginInstall: draft.registryPluginInstall,
      },
    }
    if (await props.store.save(request)) props.onDone()
  }

  return (
    <div className={styles.formBody}>
      <div className={styles.grid}>
        <TextField
          label="显示名"
          value={draft.label}
          onChange={(label) => patch({ label })}
          autoFocus={props.mode === 'create'}
          placeholder="如：开发机 A"
        />
        <TextField
          label="SSH 别名"
          value={draft.sshAlias}
          onChange={(sshAlias) => patch({ sshAlias })}
          placeholder="~/.ssh/config 主机别名"
        />
      </div>

      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>MCP 下发</h4>
        <p className={styles.hint}>
          勾选的本机 MCP 服务器声明（含 env 凭据）将整块写入远端 profile 的
          cordis.patch.yml；远端已运行的实例由其 HMR 在线应用。清单来自本机两层用户 patch。
        </p>
        {props.localRows === null || !props.localRows.available ? (
          <p className={styles.hint}>本机 MCP 清单不可用（当前宿主未提供 profileContext）。</p>
        ) : props.localRows.mcpRows.length === 0 ? (
          <p className={styles.hint}>本机没有可下发的 MCP 声明。</p>
        ) : (
          <PickList
            items={props.localRows.mcpRows.map((row) => ({
              key: row.serverName ?? row.id,
              title: row.serverName ?? row.id,
              titleMeta: row.id,
              lines: [row.summary],
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

      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>同步本地插件到远端</h4>
        <p className={styles.hint}>
          本地路径安装的插件（link / file）永远本地打包传输——未发布的开发版本也能同步； 非本地（npm
          依赖）插件按下面的选项安装。取消勾选则从远端移除（manifest 跟踪，远端手装插件不受影响）。
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
        {props.localRows === null || !props.localRows.available ? (
          <p className={styles.hint}>本机插件清单不可用（当前宿主未提供 profileContext）。</p>
        ) : props.localRows.pluginRows.length === 0 ? (
          <p className={styles.hint}>本机没有可同步的插件（两层用户 patch 里没有插件 insert 行）。</p>
        ) : (
          <PickList
            items={props.localRows.pluginRows.map((row) => ({
              key: row.name,
              title: row.name,
              titleMeta: `${row.source === 'profile' ? 'profile 层' : 'home 层'} · ${
                row.install === 'local' ? '本地' : 'npm'
              }${row.version === null ? '' : ` · v${row.version}`}`,
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

      {touched && issues.length > 0 ? <IssueList issues={issues.map((message) => ({ message }))} /> : null}
      {props.error !== null ? (
        <div className={styles.error} role="alert">
          {props.error}
        </div>
      ) : null}

      <div className={styles.formActions}>
        <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
          取消
        </Button>
        <Button variant="primary" disabled={props.busy} onClick={() => void submit()}>
          {props.busy ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
