import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TextField } from '../src'

// form.tsx 引用官方 Input / Tag；测试里以透传桩代替（真实产物外置依赖过多）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Input: (props: Record<string, unknown>) => createElement('input', props),
  Tag: ({ children }: { children: string }) => createElement('span', null, children),
}))

describe('字段行统一契约（对齐官方 SettingsValueField）', () => {
  it('说明行：label 以 htmlFor 关联控件，hint 渲染在控件下方', () => {
    const html = renderToStaticMarkup(
      createElement(TextField, {
        label: '上下文窗口',
        value: '',
        hint: '留空继承目录默认',
        onChange: () => {},
      }),
    )
    expect(html).toMatch(/for="[^"]+"/)
    expect(html).toContain('id=')
    expect(html).toContain('留空继承目录默认')
  })

  it('错误态：aria-invalid 标红，说明槽原位换成错误文案，hint 不再出现', () => {
    const html = renderToStaticMarkup(
      createElement(TextField, {
        label: '上下文窗口',
        value: 'abc',
        hint: '留空继承目录默认',
        error: '请输入整数',
        onChange: () => {},
      }),
    )
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('请输入整数')
    expect(html).not.toContain('留空继承目录默认')
  })

  it('覆盖默认值：标题行右侧渲染徽标与恢复默认，点击触发 onReset', () => {
    const onReset = vi.fn()
    const html = renderToStaticMarkup(
      createElement(TextField, {
        label: '上下文窗口',
        value: '4096',
        override: { label: '已覆盖', resetLabel: '恢复默认', onReset },
        onChange: () => {},
      }),
    )
    expect(html).toContain('已覆盖')
    expect(html).toContain('恢复默认')
    expect(html).not.toContain('type="button" disabled')
  })
})
