import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Dialog, IssueList, PickList, SelectField, TextField, type PickItem } from '@dsh-plugins/client-ui'
import type { GitInstallResponse, GitScanResponse, GitSkillCandidate, RootId, RootInfo } from '../shared'
import type { SkillsStore } from './store'
import type { SkillsT } from './locales'
import { rootOptionLabel } from './locales'
import shared from '@dsh-plugins/client-ui/styles'
import local from './SkillsSection.module.css'

const styles = { ...shared, ...local }

/** origin 的展示词：三个标准技能目录是仓库路径事实原样展示，声明类与根走词典。 */
function originLabelOf(origin: GitSkillCandidate['origin'], t: SkillsT): string {
  if (origin === 'marketplace') return t('origin.marketplace')
  if (origin === 'plugin') return t('origin.plugin')
  if (origin === 'root') return t('origin.root')
  return { skills: 'skills/', agents: '.agents/skills', claude: '.claude/skills' }[origin]
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
  t: SkillsT
  onClose(): void
}) {
  const { t } = props
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
      setScanError(t('git.scanEmpty'))
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
      titleMeta: `${originLabelOf(skill.origin, t)} · ${skill.dir}`,
      lines: [skill.description.length > 0 ? skill.description : t('pill.noDescription')],
      ...(skill.problem !== undefined ? { problem: t('git.notInstallable', { reason: skill.problem }) } : {}),
    })) ?? []

  return (
    <Dialog
      title={t('git.title')}
      description={t('git.description')}
      closeLabel={t('close')}
      onClose={() => {
        if (!props.busy) props.onClose()
      }}
      actions={
        <>
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            {done ? t('close') : t('cancel')}
          </Button>
          {!done ? (
            <Button
              variant="primary"
              disabled={props.busy || picked.size === 0}
              onClick={() => void doInstall()}
            >
              {props.installing ? t('git.installing') : t('git.installSelected', { count: picked.size })}
            </Button>
          ) : null}
        </>
      }
    >
      <div className={styles.section}>
        <TextField
          label={t('git.urlLabel')}
          wide
          value={url}
          placeholder="https://github.com/anthropics/skills"
          disabled={props.busy || done}
          onChange={setUrl}
          addon={
            !done
              ? {
                  label: props.scanning ? t('git.scanning') : t('git.scan'),
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
            label={t('git.installTo')}
            value={rootId}
            options={props.roots.map((root) => ({ value: root.id, label: rootOptionLabel(root, t) }))}
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
                <span className={styles.label}>
                  {t('git.installedCount', { count: result.installed.length })}
                </span>
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
                issues={result.conflicts.map((row) => ({
                  message: t('git.conflict', { path: row.path }),
                }))}
              />
            ) : null}
            {result.failed.length > 0 ? (
              <IssueList
                issues={result.failed.map((row) => ({
                  message: t('git.installFailed', { name: row.name, error: row.error }),
                }))}
              />
            ) : null}
          </>
        ) : null}

        <p className={styles.hint}>{t('git.hint')}</p>
      </div>
    </Dialog>
  )
}
