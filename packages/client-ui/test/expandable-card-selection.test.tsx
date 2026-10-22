import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExpandableCard } from '../src'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ IconChevronDownOutlineRegular: () => null }))

function markup(selection?: { checked: boolean; label: string; disabled?: boolean }): string {
  return renderToStaticMarkup(
    createElement(ExpandableCard, {
      open: false,
      onToggle: () => {},
      title: 'row',
      selection: selection === undefined ? undefined : { ...selection, onToggle: () => {} },
    }),
  )
}

const renderers: ReactTestRenderer[] = []
afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()))
})

function mount(selection: { checked: boolean; label: string; disabled?: boolean; onToggle(): void }) {
  const expand = vi.fn()
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      createElement(ExpandableCard, { open: false, onToggle: expand, title: 'row', selection }),
    )
  })
  renderers.push(renderer)
  return { renderer, expand }
}

describe('卡片行首选择列', () => {
  it('传入 selection 时行首渲染选择列热区：checkbox 带可访问名与勾选态，热区参与拖拽仲裁', () => {
    const html = markup({ checked: true, label: '会话 alpha' })
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('aria-label="会话 alpha"')
    expect(html).toContain('checked=""')
    // 选择框包裹在 data-drag-skip 热区内部（外层 span 先于 input 序列化）。
    expect(html.indexOf('data-drag-skip')).toBeLessThan(html.indexOf('type="checkbox"'))
  })

  it('未选中不带 checked，disabled 透传', () => {
    const html = markup({ checked: false, label: '会话 beta', disabled: true })
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('checked=""')
  })

  it('未传 selection 时行为不变：不渲染 checkbox（现有使用方零影响）', () => {
    expect(markup()).not.toContain('type="checkbox"')
  })

  it('点击选择列热区（含选择框上下空白）只切换勾选，不触发行展开', () => {
    const toggle = vi.fn()
    const { renderer, expand } = mount({ checked: false, label: 'row', onToggle: toggle })
    const zone = renderer.root.findByProps({ 'data-drag-skip': true })
    act(() => {
      zone.props.onClick({ stopPropagation: () => {} })
    })
    expect(toggle).toHaveBeenCalledOnce()
    expect(expand).not.toHaveBeenCalled()
  })

  it('disabled 时选择列点击不切换', () => {
    const toggle = vi.fn()
    const { renderer } = mount({ checked: false, label: 'row', disabled: true, onToggle: toggle })
    act(() => {
      renderer.root.findByProps({ 'data-drag-skip': true }).props.onClick({ stopPropagation: () => {} })
    })
    expect(toggle).not.toHaveBeenCalled()
  })

  it('点击选择框本体阻断冒泡：勾选走自身 onChange，与热区不重复切换', () => {
    const toggle = vi.fn()
    const { renderer, expand } = mount({ checked: false, label: 'row', onToggle: toggle })
    const input = renderer.root.findByProps({ type: 'checkbox' })
    act(() => {
      input.props.onClick({ stopPropagation: () => {} })
      input.props.onChange({})
    })
    expect(toggle).toHaveBeenCalledOnce()
    expect(expand).not.toHaveBeenCalled()
  })
})
