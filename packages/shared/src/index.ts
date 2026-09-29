// 同构工具：host 与 client 两半都内联使用，不得 import node:/浏览器专有 API。

// 鸭子类型取 message（非 Error 的拒绝也可能带 message），缺席退回 String(error)。
export function errMsg(error: unknown): string {
  const message = (error as { message?: string } | null | undefined)?.message
  return message || String(error)
}
