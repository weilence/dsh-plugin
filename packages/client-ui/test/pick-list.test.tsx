import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PickList, type PickItem } from '../src'

// 经包入口间接导入官方 primitives（外部依赖，测试环境解析不到）
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Switch: () => null }))

const rows: PickItem[] = [
  { key: 'a', title: 'alpha' },
  { key: 'b', title: 'beta', tag: 'identical' },
]

function markup(options: { items?: PickItem[]; empty?: string } = {}): string {
  return renderToStaticMarkup(
    createElement(PickList, {
      items: options.items ?? rows,
      empty: options.empty,
      picked: new Set(['a']),
      onToggle: () => {},
    }),
  )
}

describe('共享勾选清单', () => {
  it('勾选态与行尾徽标渲染，未勾选行可交互', () => {
    const html = markup()
    expect(html).toContain('alpha')
    expect(html).toContain('checked')
    expect(html).toContain('identical')
  })

  it('空清单显示占位内容；未传占位时不渲染', () => {
    expect(markup({ items: [], empty: 'nothing here' })).toContain('nothing here')
    expect(markup({ items: [] })).toBe('')
  })
})
