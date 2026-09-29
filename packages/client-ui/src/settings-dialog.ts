import { useEffect } from 'react'
import dialog from './settings-dialog.module.css'

/**
 * `settings.section` 分区根组件挂一次：本分区激活期间放大宿主设置弹窗，
 * 卸载即还原。宿主不提供弹窗尺寸 API，直接挂类是不动官方包的唯一口子；
 * 面板缺失（宿主改版）时静默退化，不影响其他分区。
 */
export function useWideSettingsDialog(): void {
  useEffect(() => {
    // 宿主快捷键系统用来识别设置弹窗的稳定 DOM 钩子
    const host = document.querySelector('[data-shortcut-modal="settings"]')
    if (host === null) return
    host.classList.add(dialog.wide)
    return () => host.classList.remove(dialog.wide)
  }, [])
}
