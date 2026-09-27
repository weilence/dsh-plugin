/**
 * 从 Git 仓库安装技能的弹窗：输入仓库地址 → host 浅克隆并发现技能 →
 * 勾选 + 选目标根 → 整目录复制安装。同名冲突拒绝不覆盖（结果里列出）。
 */

import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { IssueList, PickList, SelectField, TextField, type PickItem } from '@dsh-plugins/client-ui'
import type { GitInstallResponse, GitScanResponse, GitSkillCandidate, RootId, RootInfo } from '../shared'
import type { SkillsStore } from './store'
import shared from '@dsh-plugins/client-ui/styles'
import local from './SkillsSection.module.css'

const styles = { ...shared, ...local }

const ORIGIN_LABELS: Record<GitSkillCandidate['origin'], string> = {
  marketplace: 'marketplace 声明',
  plugin: 'plugin.json 声明',
  skills: 'skills/',
  agents: '.agents/skills',
  claude: '.claude/skills',
  root: '仓库根',
}

export function GitInstallDialog(props: {
  store: SkillsStore
  roots: readonly RootInfo[]
  busy: boolean
  /** 正在克隆扫描（按钮文案用）；区别于安装中的 busy。 */
  scanning: boolean
  /** 正在复制安装（安装按钮文案用）。 */
  installing: boolean
  error: string | null
  onClose(): void
}) {
  const [url, setUrl] = useState('')
  const [scan, setScan] = useState<GitScanResponse | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [rootId, setRootId] = useState<RootId>(() =>
    props.roots.some((root) => root.id === 'user-agents')
      ? 'user-agents'
      : (props.roots[0]?.id ?? 'user-agents'),
  )
  const [result, setResult] = useState<GitInstallResponse | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)

  const doScan = async (): Promise<void> => {
    setScanError(null)
    setScan(null)
    setResult(null)
    const response = await props.store.gitScan(url)
    if (response === null) return
    if (response.skills.length === 0) {
      setScanError(
        '仓库里没有发现技能。支持根 SKILL.md、skills/（含分类子目录）、.agents/skills/、.claude/skills/ 与 .claude-plugin/marketplace.json 声明的位置。',
      )
      return
    }
    setScan(response)
    setPicked(
      new Set(response.skills.filter((skill) => skill.problem === undefined).map((skill) => skill.dir)),
    )
  }

  const doInstall = async (): Promise<void> => {
    const response = await props.store.gitInstall(url, rootId, [...picked])
    if (response === null) return
    setResult(response)
    setPicked(new Set())
    if (response.conflicts.length === 0 && response.failed.length === 0) props.onClose()
  }

  const togglePick = (dir: string): void => {
    setPicked((previous) => {
      const next = new Set(previous)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }

  const notes: string[] = scan?.notes ?? []
  const done = result !== null
  const items: PickItem[] =
    scan?.skills.map((skill) => ({
      key: skill.dir,
      title: skill.name,
      titleMeta: `${ORIGIN_LABELS[skill.origin]} · ${skill.dir}`,
      lines: [skill.description.length > 0 ? skill.description : '（无描述）'],
      ...(skill.problem !== undefined ? { problem: `不可安装：${skill.problem}` } : {}),
    })) ?? []

  return (
    <Modal
      open
      onClose={() => {
        if (!props.busy) props.onClose()
      }}
      title="从 Git 仓库安装技能"
      closeLabel="关闭"
      className={styles.dialogSm}
      contentClassName={styles.scrollBody}
      footer={
        <>
          <span className={styles.footerMeta}>整目录复制 · 同名冲突不覆盖</span>
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            {done ? '关闭' : '取消'}
          </Button>
          {!done ? (
            <Button
              variant="primary"
              disabled={props.busy || picked.size === 0}
              onClick={() => void doInstall()}
            >
              {props.installing ? '安装中…' : `安装选中（${picked.size}）`}
            </Button>
          ) : null}
        </>
      }
    >
      <div className={styles.section}>
        <TextField
          label="仓库地址（https:// · ssh:// · git@host:owner/repo）"
          wide
          value={url}
          placeholder="https://github.com/anthropics/skills"
          disabled={props.busy || done}
          onChange={setUrl}
          addon={
            !done
              ? {
                  label: props.scanning ? '克隆扫描中…' : '扫描',
                  onClick: () => void doScan(),
                  disabled: props.busy || url.trim().length === 0,
                }
              : undefined
          }
        />
        {/* 安装到：放在滚动区之上的固定位置。若留在候选清单下方，
            首次点击获得焦点时祖先滚动容器会把它滚进可视区，Chromium
            会把这次程序性滚动当作外部交互，把刚打开的下拉立即收掉。 */}
        {!done ? (
          <SelectField
            label="安装到（同名冲突不覆盖）"
            value={rootId}
            options={props.roots.map((root) => ({ value: root.id, label: `${root.label}（${root.path}）` }))}
            onChange={(value) => setRootId(value as RootId)}
          />
        ) : null}
        {scanError ? (
          <div className={styles.error} role="alert">
            {scanError}
          </div>
        ) : null}
        {props.error ? (
          <div className={styles.error} role="alert">
            {props.error}
          </div>
        ) : null}
        {notes.length > 0 ? <IssueList issues={notes.map((note) => ({ message: note }))} /> : null}

        {scan !== null && !done ? <PickList items={items} picked={picked} onToggle={togglePick} /> : null}

        {result !== null ? (
          <>
            {result.installed.length > 0 ? (
              <div className={styles.bodyField}>
                <span className={styles.label}>已安装 {result.installed.length} 个</span>
                <ul className={styles.pickList}>
                  {result.installed.map((row) => (
                    <li key={row.path} className={styles.pickMeta}>
                      {row.name} → {row.path}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {result.conflicts.length > 0 ? (
              <IssueList
                issues={result.conflicts.map((row) => ({ message: `同名冲突（未覆盖）：${row.path}` }))}
              />
            ) : null}
            {result.failed.length > 0 ? (
              <IssueList
                issues={result.failed.map((row) => ({ message: `${row.name} 安装失败：${row.error}` }))}
              />
            ) : null}
          </>
        ) : null}

        <p className={styles.hint}>
          host 用部分克隆 + 稀疏检出只拉取技能相关目录（skills/、.agents/skills/、.claude-plugin/
          及清单声明的插件目录，docs 等其余内容不落盘；复用本机 git
          凭据，私有仓库可用），扫描后整目录复制到目标根；
          临时目录随即删除。同名技能已存在时不覆盖，请先删除或换目标根。
        </p>
      </div>
    </Modal>
  )
}
