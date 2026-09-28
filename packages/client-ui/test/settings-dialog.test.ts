import { describe, expect, it, vi } from 'vitest'
import { mountWideSettingsDialog } from '../src/settings-dialog'

function stubPanel() {
  return { classList: { add: vi.fn(), remove: vi.fn() } }
}

describe('设置弹窗加宽', () => {
  it('挂载时给面板加类，清理时移除同一个类', () => {
    const panel = stubPanel()
    const cleanup = mountWideSettingsDialog(panel as unknown as Element)
    expect(panel.classList.add).toHaveBeenCalledTimes(1)
    cleanup()
    expect(panel.classList.remove).toHaveBeenCalledWith(vi.mocked(panel.classList.add).mock.calls[0][0])
  })

  it('面板缺失（宿主改版）时退化为空操作', () => {
    expect(mountWideSettingsDialog(null)).toBeInstanceOf(Function)
  })
})
