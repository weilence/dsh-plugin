// 同构工具：host 与 client 两半都内联使用，不得 import node:/浏览器专有 API。

/** 取 error.message（鸭子类型：任何带真值 message 的对象），缺席时退回 String(error)。 */
export function errMsg(error: unknown): string {
  const message = (error as { message?: string } | null | undefined)?.message
  return message || String(error)
}
