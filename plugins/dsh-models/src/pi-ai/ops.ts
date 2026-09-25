// 把面板动作翻译成 llm-pi-ai settings 写入。
//
// 所有写入都只作用于 `llm-pi-ai` 的 raw user 层：
//   - 新建/修改一个 route：`set ['providers', route]`（整值替换）
//   - 删除一个 route：`unset ['providers', route]`
// 与官方 Models 页的取舍一致：绝不重建 base，绝不触碰 llm-deepseek。

/**
 * 深比较两棵 JSON 值的结构相等性。
 * 用于判断「这次编辑是否真的改了东西」，避免制造同值写与 revision 抖动。
 */
export function jsonEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true
	if (typeof left !== typeof right) return false
	if (left === null || right === null) return false
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
		return left.every((value, index) => jsonEqual(value, right[index]))
	}
	if (typeof left === 'object') {
		const a = left as Record<string, unknown>
		const b = right as Record<string, unknown>
		const keys = Object.keys(a)
		if (keys.length !== Object.keys(b).length) return false
		return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
	}
	return false
}

/** 一个写入结果，UI 直接据此渲染。 */
export type WriteOutcome =
	{ kind: 'written' } | { kind: 'conflict'; message: string } | { kind: 'refused'; message: string }

/** settings.mutate 的回答 → UI 结果。 */
export function classifyWrite(
	response: { ok: true } | { ok: false; error: { code?: string; message: string } },
): WriteOutcome {
	if (response.ok) return { kind: 'written' }
	if (response.error.code === 'settings/conflict')
		return { kind: 'conflict', message: response.error.message }
	return { kind: 'refused', message: response.error.message }
}
