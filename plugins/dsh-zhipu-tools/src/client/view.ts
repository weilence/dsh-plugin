import type { SearchSwitchView } from '../shared'

/** 开关的展示投影：纯函数，供面板渲染与单测共用。 */
export interface SwitchDisplay {
  checked: boolean
  disabled: boolean
  switchTitle: string | undefined
  waiting: boolean
  providerText: string
  sourceText: string
  effectText: string
  hint: string | null
}

export function projectSwitch(view: SearchSwitchView, pending: boolean | null, busy: boolean): SwitchDisplay {
  const checked = pending ?? view.active
  const waiting = pending !== null && view.active !== pending
  const disabled = busy || !view.editable
  const providerText = view.effectiveProvider ?? view.fileProvider ?? '（未配置，自动选择）'
  const sourceText =
    view.effectiveProvider !== undefined
      ? view.effectiveProvider === view.fileProvider || view.fileProvider === null
        ? '运行时生效值'
        : `运行时生效值（两层文件算出 ${view.fileProvider ?? '（未配置）'}，尚未一致）`
      : '两层文件推算（运行时不可读）'
  const effectText = waiting ? '等待宿主应用…' : view.hotApply ? '修改可在线生效' : '写入后需重启宿主生效'
  let hint: string | null = view.reason
  if (waiting) {
    hint = view.hotApply
      ? '已写入，宿主正在重新组装配置（约数秒）'
      : '已写入；当前宿主不支持在线生效，重启后生效'
  } else if (view.editable && view.active) {
    hint = '卸载本插件前请先关闭替换，否则残留的 patch 行会让 web_search 找不到智谱提供者'
  }
  return {
    checked,
    disabled,
    switchTitle: view.editable ? undefined : (view.reason ?? '当前不可修改'),
    waiting,
    providerText,
    sourceText,
    effectText,
    hint,
  }
}
