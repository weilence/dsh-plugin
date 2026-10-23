import { useEffect, useRef, useState } from 'react'
import { Button, IconRefreshOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { errMsg } from '@dsh-plugins/shared'
import sharedStyles from '@dsh-plugins/client-ui/styles'
import type { GitLog, GitRepoInfo, GitRepoScan } from '../shared'
import { readLog, scanRepos } from './api'
import { CommitGraph } from './CommitGraph'
import type { GitT } from './locales'
import css from './ReposBody.module.css'

export interface ReposBodyInjected {
  /** 按宿主语言格式化时间戳（毫秒）。 */
  formatTime: (timestampMs: number) => string
}

export type ReposBodyProps = PropsRuntime<'sidebar.right.pane.tab'> &
  PropsLocale<'dsh-git'> &
  InjectFace<ReposBodyInjected>

type Scan = { phase: 'loading' } | { phase: 'done'; scan: GitRepoScan } | { phase: 'failed'; error: string }
type Log =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done'; log: GitLog }
  | { phase: 'failed'; error: string }

function selectDefault(
  repos: readonly GitRepoInfo[],
  cwd: string | undefined,
  previous: string | null,
): string | null {
  if (previous !== null && repos.some((repo) => repo.root === previous)) return previous
  if (cwd !== undefined) {
    const atCwd = repos.find((repo) => repo.root === cwd)
    if (atCwd !== undefined) return atCwd.root
  }
  return repos[0]?.root ?? null
}

export function ReposBody({ sessionId, useSessions, t, formatTime }: ReposBodyProps) {
  const cwd = useSessions((state) => state.byId[sessionId]?.cwd)
  const [scan, setScan] = useState<Scan>({ phase: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  const [log, setLog] = useState<Log>({ phase: 'idle' })
  const [refreshTick, setRefreshTick] = useState(0)
  // 请求序号：新请求开始即作废未完成的旧结果，迟到响应不落屏
  const scanEpoch = useRef(0)
  const logEpoch = useRef(0)

  useEffect(() => {
    if (cwd === undefined) {
      setScan({ phase: 'loading' })
      return
    }
    const epoch = ++scanEpoch.current
    setScan({ phase: 'loading' })
    scanRepos(cwd, new AbortController().signal)
      .then((result) => {
        if (epoch !== scanEpoch.current) return
        setScan({ phase: 'done', scan: result })
      })
      .catch((error: unknown) => {
        if (epoch !== scanEpoch.current) return
        setScan({ phase: 'failed', error: errMsg(error) })
      })
  }, [cwd, refreshTick])

  const repos = scan.phase === 'done' ? scan.scan.repos : []
  const effectiveSelected = selectDefault(repos, cwd, selected)
  const selectedRepo = repos.find((repo) => repo.root === effectiveSelected)

  useEffect(() => {
    if (effectiveSelected === null) {
      setLog({ phase: 'idle' })
      return
    }
    const epoch = ++logEpoch.current
    setLog({ phase: 'loading' })
    readLog(effectiveSelected, new AbortController().signal)
      .then((result) => {
        if (epoch !== logEpoch.current) return
        setLog({ phase: 'done', log: result })
      })
      .catch((error: unknown) => {
        if (epoch !== logEpoch.current) return
        setLog({ phase: 'failed', error: errMsg(error) })
      })
  }, [effectiveSelected, refreshTick])

  const refresh = () => setRefreshTick((tick) => tick + 1)

  return (
    <div className={css.body}>
      <header className={css.header}>
        <select
          className={css.select}
          value={effectiveSelected ?? ''}
          aria-label={t('repo.select')}
          disabled={repos.length === 0}
          onChange={(event) => setSelected(event.target.value)}
        >
          {repos.map((repo) => (
            <option key={repo.root} value={repo.root}>
              {repo.relPath === '.' ? repo.name : `${repo.name}（${repo.relPath}）`}
            </option>
          ))}
        </select>
        <Tooltip label={t('refresh')} side="bottom" delayMs={500}>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('refresh')}
            icon={<IconRefreshOutlineRegular size={14} />}
            disabled={cwd === undefined}
            onClick={refresh}
          />
        </Tooltip>
      </header>
      {selectedRepo !== undefined && (
        <div className={css.summary}>
          <span className={`${sharedStyles.code} ${css.summaryPath}`} title={selectedRepo.root}>
            {selectedRepo.root}
          </span>
          {selectedRepo.branch !== undefined && (
            <span className={`${sharedStyles.code} ${css.summaryBranch}`}>{selectedRepo.branch}</span>
          )}
          {selectedRepo.kind !== 'standard' && (
            <span className={css.summaryKind}>
              {t(selectedRepo.kind === 'bare' ? 'repo.bare' : 'repo.linked')}
            </span>
          )}
        </div>
      )}
      {scan.phase === 'done' && scan.scan.truncated && <p className={css.note}>{t('scan.truncated')}</p>}
      {cwd === undefined ? (
        <p className={css.note} role="status">
          {t('scan.noCwd')}
        </p>
      ) : scan.phase === 'loading' ? (
        <p className={css.note} role="status">
          {t('scan.loading')}
        </p>
      ) : scan.phase === 'failed' ? (
        <p className={css.note} role="alert">
          {scan.error}
        </p>
      ) : repos.length === 0 ? (
        <p className={css.note}>{t('scan.empty')}</p>
      ) : log.phase === 'idle' ? null : log.phase === 'loading' ? (
        <p className={css.note} role="status">
          {t('log.loading')}
        </p>
      ) : log.phase === 'failed' ? (
        <p className={css.note} role="alert">
          {log.error}
        </p>
      ) : log.log.commits.length === 0 ? (
        <p className={css.note}>{t('log.empty')}</p>
      ) : (
        <CommitGraph
          repo={effectiveSelected!}
          commits={log.log.commits}
          truncated={log.log.truncated}
          t={t}
          formatTime={formatTime}
        />
      )}
    </div>
  )
}
