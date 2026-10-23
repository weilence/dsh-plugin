import { describe, expect, it } from 'vitest'
import { layoutLanes, placeCard, ROW_HEIGHT, rowAnchorSpan } from '../../src/client/graph'

const commit = (hash: string, ...parents: string[]) => ({ hash, parents })

describe('提交图泳道布局', () => {
  it('线性历史单泳道直行，根提交止于提交点', () => {
    const layout = layoutLanes([commit('c3', 'c2'), commit('c2', 'c1'), commit('c1')])
    expect(layout.laneCount).toBe(1)
    expect(layout.rows).toEqual([
      { lane: 0, incoming: [], outgoing: [{ from: 0, to: 0 }], through: [] },
      { lane: 0, incoming: [{ from: 0, to: 0 }], outgoing: [{ from: 0, to: 0 }], through: [] },
      { lane: 0, incoming: [{ from: 0, to: 0 }], outgoing: [], through: [] },
    ])
  })

  it('分叉：首父直行，次父开新泳道；父提交落在期待它的泳道上', () => {
    const layout = layoutLanes([commit('m', 'b', 'a'), commit('b', 'a'), commit('a')])
    expect(layout.laneCount).toBe(2)
    expect(layout.rows).toEqual([
      {
        lane: 0,
        incoming: [],
        outgoing: [
          { from: 0, to: 0 },
          { from: 0, to: 1 },
        ],
        through: [],
      },
      { lane: 0, incoming: [{ from: 0, to: 0 }], outgoing: [{ from: 0, to: 1 }], through: [1] },
      { lane: 1, incoming: [{ from: 1, to: 1 }], outgoing: [], through: [] },
    ])
  })

  it('独立头部分支各自成泳道，合并弧线并入既有泳道后释放', () => {
    const layout = layoutLanes([commit('h2', 'base'), commit('h1', 'base'), commit('base')])
    expect(layout.laneCount).toBe(2)
    expect(layout.rows).toEqual([
      { lane: 0, incoming: [], outgoing: [{ from: 0, to: 0 }], through: [] },
      { lane: 1, incoming: [], outgoing: [{ from: 1, to: 0 }], through: [0] },
      { lane: 0, incoming: [{ from: 0, to: 0 }], outgoing: [], through: [] },
    ])
  })

  it('首父已被其他泳道期待时并入该泳道，原泳道释放', () => {
    const layout = layoutLanes([
      commit('top', 'mid', 'side'),
      commit('side', 'base'),
      commit('mid', 'base'),
      commit('base'),
    ])
    expect(layout.laneCount).toBe(2)
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 1, 0, 1])
    expect(layout.rows[1]).toEqual({
      lane: 1,
      incoming: [{ from: 1, to: 1 }],
      outgoing: [{ from: 1, to: 1 }],
      through: [0],
    })
    expect(layout.rows[2]).toEqual({
      lane: 0,
      incoming: [{ from: 0, to: 0 }],
      outgoing: [{ from: 0, to: 1 }],
      through: [1],
    })
    expect(layout.rows[3]).toEqual({
      lane: 1,
      incoming: [{ from: 1, to: 1 }],
      outgoing: [],
      through: [],
    })
  })
})

describe('悬停锚点行缘', () => {
  it('只取紧凑行：区间为行顶到行顶加常规行高，与行的实际（展开）高度无关', () => {
    expect(rowAnchorSpan(40)).toEqual({ rowTop: 40, rowBottom: 68 })
    expect(rowAnchorSpan(0)).toEqual({ rowTop: 0, rowBottom: ROW_HEIGHT })
  })
})

describe('悬停卡片落点', () => {
  it('空间充足时贴行下缘、左缘对齐指针（右下）', () => {
    expect(placeCard(100, 100, 128, 300, 200, 1920, 1080)).toEqual({ left: 100, top: 128 })
  })

  it('右侧放不下翻到指针左侧：右缘对齐指针（左下）', () => {
    expect(placeCard(1700, 100, 128, 300, 200, 1920, 1080)).toEqual({ left: 1400, top: 128 })
  })

  it('下方放不下翻到行上方：底缘贴行顶（右上）', () => {
    expect(placeCard(100, 950, 978, 300, 200, 1920, 1080)).toEqual({ left: 100, top: 750 })
  })

  it('右下都放不下则同时翻面（左上）', () => {
    expect(placeCard(1700, 950, 978, 300, 200, 1920, 1080)).toEqual({ left: 1400, top: 750 })
  })

  it('极小视口都放不下时贴边缘收拢', () => {
    expect(placeCard(100, 0, 28, 300, 200, 200, 100)).toEqual({ left: 8, top: 8 })
  })
})
