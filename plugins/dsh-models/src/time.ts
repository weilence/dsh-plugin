// 快照 meta 与缓存 header 的时间戳来自外部文件/网络，只有正有限数才当作 epoch 毫秒。
export function positiveTime(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}
