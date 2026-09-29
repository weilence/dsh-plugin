import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CardList } from '../src'
import { reorderTarget } from '../src/drag'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ IconChevronDownOutlineRegular: () => null }))

const rows = ['alpha', 'beta', 'gamma']

function markup(options: { reorder?: boolean; disabled?: string; before?: string; after?: string } = {}) {
  return renderToStaticMarkup(
    createElement(CardList<string>, {
      items: rows,
      getKey: (item) => item,
      renderCard: (item) => ({ title: item, open: false, onToggle: () => {} }),
      onReorder: options.reorder ? () => {} : undefined,
      canDrag: (item) => item !== options.disabled,
      before: options.before,
      after: options.after,
    }),
  )
}

describe('共享卡片列表', () => {
  it('固定内容排在数据行之外，顺序保持不变', () => {
    const html = markup({ before: 'new', after: 'creating' })
    expect(html.indexOf('new')).toBeLessThan(html.indexOf('alpha'))
    expect(html.indexOf('alpha')).toBeLessThan(html.indexOf('beta'))
    expect(html.indexOf('beta')).toBeLessThan(html.indexOf('gamma'))
    expect(html.indexOf('gamma')).toBeLessThan(html.indexOf('creating'))
  })

  it('仅可排序且允许拖动的行具有拖拽属性', () => {
    expect(markup().match(/draggable="true"/g)).toBeNull()
    expect(markup({ reorder: true, disabled: 'beta' }).match(/draggable="true"/g)).toHaveLength(2)
  })

  it('仅数据为空时显示空态，同时保留固定卡片', () => {
    const html = renderToStaticMarkup(
      createElement(CardList<string>, {
        items: [],
        getKey: (item) => item,
        renderCard: (item) => ({ title: item, open: false, onToggle: () => {} }),
        before: 'new',
        empty: 'none',
        after: 'creating',
      }),
    )
    expect(html).toContain('new')
    expect(html).toContain('none')
    expect(html).toContain('creating')
    expect(markup()).not.toContain('none')
  })
})

describe('卡片拖拽目标', () => {
  it('下方目标按移除原位后的下标提交', () => {
    expect(reorderTarget(0, { index: 2, half: 'after' })).toBe(2)
    expect(reorderTarget(0, { index: 1, half: 'before' })).toBeNull()
  })

  it('上方目标按插入边界提交，原位放置被忽略', () => {
    expect(reorderTarget(2, { index: 0, half: 'before' })).toBe(0)
    expect(reorderTarget(2, { index: 1, half: 'after' })).toBeNull()
  })
})
