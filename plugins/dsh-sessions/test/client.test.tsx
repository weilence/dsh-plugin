import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Preview, SessionSection, apply } from '../src/client'
import { en, zh } from '../src/client/locales'
import type { ArchivePreview } from '../src/shared'
import { makeT } from './i18n'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
}))
vi.mock('@dsh-plugins/client-ui', () => ({
  Panel: ({ title, subtitle, children }: { title: string; subtitle: string; children?: ReactNode }) => (
    <section>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </section>
  ),
  useWideSettingsDialog: () => undefined,
}))

const preview: ArchivePreview = {
  expected: {
    archiveDigest: 'a'.repeat(64),
    cwd: '/target',
    sessions: { first: null, second: 'b'.repeat(64) },
  },
  sessions: [
    { id: 'first', eventCount: 1, cwd: '/source', status: 'new' },
    { id: 'second', eventCount: 5, status: 'conflict' },
  ],
  warnings: ['cold-storage-only', 'cwd-history-unchanged', 'non-atomic-tree-snapshot'],
}

describe('会话迁移界面', () => {
  it('离线和远端入口常驻，无前置条件时按钮不可执行', () => {
    const html = renderToStaticMarkup(
      <SessionSection t={makeT()} onImported={async () => {}} close={() => {}} />,
    )
    expect(html).toContain('离线恢复')
    expect(html).toContain('传输到远端')
    expect(html).toContain('导出 ZIP')
    expect(html).toContain('远端也需启用 dsh-sessions')
    expect(html).toContain('日志中的权限设置（包括完全访问和禁用审批）')
    expect(html).toContain('未脱敏、未加密')
    expect(html.match(/disabled=""/g)?.length).toBe(5)
  })

  it('预览保留可复制的完整 ID 和原工作目录，冲突不承诺覆盖', () => {
    const html = renderToStaticMarkup(<Preview preview={preview} t={makeT()} />)
    expect(html).toContain('<code>first</code>')
    expect(html).toContain('<code>/source</code>')
    expect(html).toContain('5 条事件')
    expect(html).toContain('内容不同，禁止覆盖')
    expect(html).toContain('存在冲突，不能导入')
  })

  it('面板和预览完全跟随宿主语言', () => {
    const html = renderToStaticMarkup(
      <SessionSection t={makeT('en')} onImported={async () => {}} close={() => {}} />,
    )
    expect(html).toContain('Offline restore')
    expect(html).toContain('Transfer to remote')
    expect(html).not.toContain('离线恢复')
    const result = renderToStaticMarkup(<Preview preview={preview} t={makeT('en')} />)
    expect(result).toContain('Preview: 2 sessions')
    expect(result).toContain('Different; cannot overwrite')
    expect(result).not.toContain('禁止覆盖')
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('locale 注册由 effect 托管，导航在取值时翻译，导入刷新不自动打开会话', async () => {
    let language: 'zh' | 'en' = 'zh'
    let registration:
      { label: () => string; inject: () => { onImported: () => Promise<void> }; locale: string } | undefined
    const refresh = vi.fn(async () => {})
    const dictionaries = vi.fn(() => () => {})
    const context = {
      sessions: { refresh },
      effect(callback: () => unknown) {
        callback()
      },
      locale: {
        register: dictionaries,
        bind: () => (key: string) => (language === 'zh' ? zh : en)[key as keyof typeof zh],
      },
      slots: {
        inject(_slot: string, callback: () => unknown) {
          callback()
        },
        register(meta: typeof registration) {
          registration = meta
        },
      },
    } as never
    apply(context)
    expect(dictionaries).toHaveBeenCalledWith('dsh-sessions', { zh, en })
    expect(registration?.locale).toBe('dsh-sessions')
    expect(registration?.label()).toBe('会话迁移')
    language = 'en'
    expect(registration?.label()).toBe('Session migration')
    await registration?.inject().onImported()
    expect(refresh).toHaveBeenCalledOnce()
  })
})
