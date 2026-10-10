import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ErrorDetailDialog, ExpandableCard } from '../src'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  Modal: ({ title, children }: { title?: React.ReactNode; children?: React.ReactNode }) => (
    <div>
      {title}
      {children}
    </div>
  ),
}))

const DETAIL = {
  text: 'line-1\nline-2\nline-3',
  title: '完整错误详情',
  expandLabel: '查看完整',
  closeLabel: '关闭',
}

function markup(errorDetail?: typeof DETAIL): string {
  return renderToStaticMarkup(
    createElement(ExpandableCard, {
      open: false,
      onToggle: () => {},
      title: 'row',
      error: '摘要行',
      errorDetail,
    }),
  )
}

describe('卡片错误详情机制', () => {
  it('传入 errorDetail 时错误行渲染「查看完整」入口', () => {
    const html = markup(DETAIL)
    expect(html).toContain('摘要行')
    expect(html).toContain('>查看完整</button>')
  })

  it('未传 errorDetail 时错误行保持原样，无详情入口（默认行为不变）', () => {
    const html = markup()
    expect(html).toContain('摘要行')
    expect(html).not.toContain('查看完整')
  })

  it('error 为空时不渲染错误行，也不渲染详情入口', () => {
    const html = renderToStaticMarkup(
      createElement(ExpandableCard, {
        open: false,
        onToggle: () => {},
        title: 'row',
        errorDetail: DETAIL,
      }),
    )
    expect(html).not.toContain('查看完整')
  })

  it('详情弹窗渲染全文（可选中复制）与标题', () => {
    const html = renderToStaticMarkup(createElement(ErrorDetailDialog, { ...DETAIL, onClose: () => {} }))
    expect(html).toContain('完整错误详情')
    expect(html).toContain('line-1')
    expect(html).toContain('line-3')
    expect(html).toContain('<pre')
  })
})
