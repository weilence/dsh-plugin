/** 双端 wire 类型与常量：搜索替换开关的面板 ↔ host 路由。 */

export const SWITCH_STATE_PATH = '/dsh-zhipu-tools/search-switch'
export const SWITCH_SET_PATH = '/dsh-zhipu-tools/search-switch/set'

/** 搜索提供者 id：与本包注册的 WebSearchProvider 一致。 */
export const ZHIPU_PROVIDER = 'zhipu'
/** 官方基础组合默认选中的搜索提供者。 */
export const OFFICIAL_PROVIDER = 'deepseek-official'

/** GET search-switch 响应：面板据此渲染开关态与可编辑性。 */
export interface SearchSwitchView {
  /** 运行时实际生效的 searchProvider（undefined = 内省不可用，降级文件值）。 */
  effectiveProvider: string | undefined
  /** 生效值是否为智谱（内省可用以运行时为准，否则按两层文件折叠）。 */
  active: boolean
  /** 两层文件按 fold 序算出的 searchProvider（null = 两层都没有 web 行）。 */
  fileProvider: string | null
  /** 开关是否可写（生效来源可被用户文件覆盖）。 */
  editable: boolean
  /** 不可编辑的具体原因。 */
  reason: string | null
  /** HMR 在场：写入可在线生效；否则需重启。 */
  hotApply: boolean
  /** 两层 patch 文件绝对路径（展示与定位用）。 */
  patchPaths: { profile: string; home: string }
  /** 下一次开启将写入的位置（展示用）。 */
  writeTarget: 'in-place:profile' | 'in-place:home' | 'create:home'
}

/** POST search-switch/set 请求体。 */
export interface SearchSwitchSetRequest {
  enabled: boolean
}

/** POST search-switch/set 响应。 */
export interface SearchSwitchSetResponse {
  enabled: boolean
  /** 实际写入的层。 */
  scope: 'profile' | 'home'
  /** 本次是否发生落盘（已处于目标态时为 false）。 */
  written: boolean
}
