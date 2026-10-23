import { createBridgeClient } from '@dsh-plugins/shared/api'
import {
  DEFAULT_LOG_LIMIT,
  FILES_PATH,
  GIT_HEADER,
  LOG_PATH,
  REPOS_PATH,
  type GitCommitFiles,
  type GitLog,
  type GitRepoScan,
} from '../shared'

const bridge = createBridgeClient(GIT_HEADER)

export function scanRepos(cwd: string, signal: AbortSignal): Promise<GitRepoScan> {
  return bridge.request(REPOS_PATH, { method: 'POST', body: JSON.stringify({ cwd }), signal })
}

export function readLog(
  repo: string,
  signal: AbortSignal,
  limit: number = DEFAULT_LOG_LIMIT,
): Promise<GitLog> {
  return bridge.request(LOG_PATH, { method: 'POST', body: JSON.stringify({ repo, limit }), signal })
}

export function readCommitFiles(repo: string, hash: string, signal: AbortSignal): Promise<GitCommitFiles> {
  return bridge.request(FILES_PATH, { method: 'POST', body: JSON.stringify({ repo, hash }), signal })
}
