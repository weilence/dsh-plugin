import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useUsageQuota } from './quota-shared'
import { QuotaPill } from './quota-pill'

interface SlotDefinition {
  name?: string
  id?: string
  order?: number
  label?: string
  inject?: (sessionId: string) => Record<string, unknown>
}

// model-selection 包的共享目录（宿主内常驻）；结构化声明，不可用时胶囊隐藏。
interface ModelDirectorySnapshotLike {
  status?: string
  current?: { provider?: string; model?: string } | null
}

interface ModelDirectoryLike {
  store: {
    getSnapshot(): ModelDirectorySnapshotLike
    subscribe(listener: () => void): () => void
  }
  load?(): Promise<unknown>
}

interface ModelDirectoriesLike {
  directoryFor(sessionId: string): ModelDirectoryLike
}

interface ClientContext {
  slots: {
    inject(name: string, register: () => unknown): void
    register(definition: SlotDefinition, render: unknown): unknown
  }
  modelDirectories?: ModelDirectoriesLike
  effect(fn: () => unknown, label?: string): unknown
}

const EMPTY_SNAPSHOT: ModelDirectorySnapshotLike = {}

const TARGET_PROVIDER = 'zai-coding-cn'

function useModelProvider(directories: ModelDirectoriesLike | undefined, sessionId: string) {
  const directory = directories?.directoryFor(sessionId)

  // 确保目录装载宿主 catalog（幂等）；装载前 current 为 null，胶囊不显示。
  useEffect(() => {
    void directory?.load?.()?.catch(() => {})
  }, [directory])

  const subscribe = useCallback(
    (listener: () => void) => directory?.store.subscribe(listener) ?? (() => {}),
    [directory],
  )
  const snapshot = useSyncExternalStore(subscribe, () => directory?.store.getSnapshot() ?? EMPTY_SNAPSHOT)
  return snapshot.current?.provider ?? null
}

interface QuotaChipProps {
  sessionId: string
  directories?: ModelDirectoriesLike
}

function ZhipuQuotaChip(props: QuotaChipProps) {
  const provider = useModelProvider(props.directories, props.sessionId)
  const active = provider === TARGET_PROVIDER
  const { res, refresh } = useUsageQuota(active)

  if (!active) return null
  return <QuotaPill res={res} onForceRefresh={refresh} />
}

export const inject: string[] = ['slots', 'modelDirectories']

export function apply(ctx: ClientContext) {
  ctx.slots.inject('conversation.input.right', () => {
    // 插槽定义的 inject(sessionId) 回调由宿主按会话调用并下发 sessionId。
    return ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'zhipu-tools-usage',
        order: 10,
        inject: (sessionId: string) => ({ sessionId, directories: ctx.modelDirectories }),
      },
      ZhipuQuotaChip,
    )
  })
}
