// 客户端侧的小工具函数。

/** 从任意抛出的值里取可读的诊断文本（Remote Error、普通 Error、字符串都行）。 */
export function errMsg(error: unknown): string {
	const message = (error as { message?: string } | null | undefined)?.message
	return message || String(error)
}
