/**
 * 提交图泳道布局：输入拓扑序（子先于父）的提交与父链接，输出每行的
 * 连线段——行顶进入提交点的 incoming、提交点到底部的 outgoing、与本提交
 * 无关而整行穿越的 through。渲染端每行画一段 SVG strip，无需全局协调。
 */

export interface LaneEdge {
  from: number
  to: number
}

export interface CommitLayout {
  /** 提交点所在泳道。 */
  lane: number
  /** 行顶进入提交点；合并提交会有多条汇入。 */
  incoming: readonly LaneEdge[]
  /** 提交点到行底；首父直行或并入既有泳道，次父分叉到新泳道。 */
  outgoing: readonly LaneEdge[]
  /** 整行穿越的泳道。 */
  through: readonly number[]
}

export interface LaneLayout {
  rows: readonly CommitLayout[]
  /** 所有行引用到的最大泳道数（≥1），决定绘制宽度。 */
  laneCount: number
}

export function layoutLanes(commits: readonly { hash: string; parents: readonly string[] }[]): LaneLayout {
  // 每条泳道期待的下一个提交哈希；null 表示空闲
  const lanes: (string | null)[] = []
  const rows: CommitLayout[] = []
  let laneCount = 1

  const takeFree = (): number => {
    const free = lanes.indexOf(null)
    if (free !== -1) return free
    lanes.push(null)
    return lanes.length - 1
  }

  for (const commit of commits) {
    const hits: number[] = []
    for (const [index, expected] of lanes.entries()) {
      if (expected === commit.hash) hits.push(index)
    }
    const commitLane = hits.length > 0 ? hits[0]! : takeFree()
    const incoming = hits.map((from) => ({ from, to: commitLane }))
    for (const hit of hits.slice(1)) lanes[hit] = null

    const outgoing: LaneEdge[] = []
    const assigned = new Set<number>()
    const [firstParent, ...otherParents] = commit.parents
    if (firstParent === undefined) {
      lanes[commitLane] = null
    } else {
      const existing = lanes.indexOf(firstParent)
      if (existing === -1) {
        lanes[commitLane] = firstParent
        outgoing.push({ from: commitLane, to: commitLane })
      } else {
        outgoing.push({ from: commitLane, to: existing })
        lanes[commitLane] = null
      }
    }
    for (const parent of otherParents) {
      const existing = lanes.indexOf(parent)
      if (existing !== -1 && existing !== commitLane) {
        outgoing.push({ from: commitLane, to: existing })
      } else {
        const lane = takeFree()
        lanes[lane] = parent
        outgoing.push({ from: commitLane, to: lane })
        assigned.add(lane)
      }
    }

    const through: number[] = []
    for (const [index, expected] of lanes.entries()) {
      if (expected !== null && index !== commitLane && !assigned.has(index)) through.push(index)
    }

    const referenced = [
      commitLane,
      ...incoming.flatMap(({ from, to }) => [from, to]),
      ...outgoing.flatMap(({ from, to }) => [from, to]),
      ...through,
    ]
    laneCount = Math.max(laneCount, ...referenced.map((index) => index + 1))
    rows.push({ lane: commitLane, incoming, outgoing, through })
  }

  return { rows, laneCount }
}
