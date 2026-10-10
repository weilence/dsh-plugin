import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SearchBox } from '../src'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ IconSearchOutlineRegular: () => null }))

describe('共享搜索框', () => {
  it('官方清单页同款结构：search 输入 + 放大镜，占位与可访问名同词，附视觉隐藏标签', () => {
    const html = renderToStaticMarkup(
      createElement(SearchBox, { value: 'alpha', label: '搜索标题、路径或会话 ID', onChange: () => {} }),
    )
    expect(html).toContain('type="search"')
    expect(html).toContain('value="alpha"')
    expect(html).toContain('placeholder="搜索标题、路径或会话 ID"')
    expect(html).toContain('aria-label="搜索标题、路径或会话 ID"')
    expect(html).toMatch(/visuallyHidden/)
  })
})
