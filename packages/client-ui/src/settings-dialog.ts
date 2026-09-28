import { useEffect } from 'react'
import dialog from './settings-dialog.module.css'

/** 弹窗面板在 DOM 里的稳定钩子（宿主快捷键系统用来识别设置弹窗）。 */
export const SETTINGS_PANEL_SELECTOR = '[data-shortcut-modal="settings"]'

/**
 * 把加宽类挂到宿主设置弹窗面板上，返回卸载清理；面板缺失（宿主改版）时
 * 静默退化为原尺寸，不影响其他分区。
 */
export function mountWideSettingsDialog(host: Element | null): () => void {
  if (host === null) return () => {}
  host.classList.add(dialog.wide)
  return () => host.classList.remove(dialog.wide)
}

/**
 * `settings.section` 分区根组件挂一次：本分区激活期间放大宿主设置弹窗，
 * 卸载即还原（renderSlot 的 only 过滤保证挂载 = 分区激活）。宿主不提供
 * 弹窗尺寸 API，这是唯一不动官方包的口子。
 */
export function useWideSettingsDialog(): void {
  useEffect(() => mountWideSettingsDialog(document.querySelector(SETTINGS_PANEL_SELECTOR)), [])
}
