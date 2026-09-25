// 官方 YAML 渲染：预览必须与真正落盘的文本同风格。
//
// 真源是 Host 的 settings 文件提供方（`dsh-settings-file`）：
//
//   renderYaml(ns, section) {
//     if (this.text === undefined) return new Document({ [ns]: section }).toString()
//     const document = parseDocument(this.text)
//     ...
//     return document.toString()
//   }
//
// 它用的是 `yaml` 包的 `Document`。这里刻意内联同一个库、同一个入口，而不是
// 手写一个「够用的」YAML emitter：引号、转义、多行字符串、键序这些规则一旦
// 与官方不同，预览就会在运维真正需要复制粘贴时骗人。代价是客户端 bundle
// 增加约 100KB（gzip 约 27KB），对这个面板是值得的。
//
// 注意一个语义细节：官方对**已有文件**是 patch 式写入，`off:`（解析为 null）
// 这种原有写法会被保留；而全新写入会渲染成 `off: null`。两者解析结果相同，
// 因此预览展示 `off: null` 是准确的（它正是新写入时的文本）。

import { Document } from 'yaml'

/**
 * 渲染一段将写入 `settings.yaml` 的配置文本。
 *
 * @param value JSON 形态的值（settings 只接受 JSON 兼容数据）。
 * @returns 与官方文件提供方同风格的 YAML 文本（带结尾换行）。
 */
export function toYamlPreview(value: unknown): string {
	// 官方 Document#toString() 自带结尾换行；不额外补一个，否则预览会多出一个空行。
	return new Document(value as Record<string, unknown>).toString()
}

/**
 * 渲染某个 route 子树，并带上它落在 settings.yaml 里的位置注释。
 *
 * `settings.mutate` 的 op 是 `set ['providers', route]`，因此这段文本就是
 * 该 route 在文件里的完整内容（缩进层级由外层 section 决定）。
 *
 * @param provider route 键。
 * @param profile 该 route 的候选 profile。
 * @returns 带落地位置注释的 YAML 文本。
 */
export function toRoutePreview(provider: string, profile: unknown): string {
	return `# llm-pi-ai → providers.${provider}\n${toYamlPreview({ providers: { [provider]: profile } }).trimStart()}`
}

/**
 * 从候选 profile 判断这次写入落到官方哪条路径。
 *
 * 用来给预览加一句准确的说明：目录 route 编辑既有模型写 `modelOverrides`，
 * 显式清单/手写 route 写 `models`。判断只看候选本身，因此不会与实际写入分叉。
 *
 * @param profile 候选 profile。
 * @returns 写入路径。
 */
export function writePathOf(profile: Record<string, unknown>): 'models' | 'modelOverrides' | 'empty' {
	if (Array.isArray(profile['models']) && profile['models'].length > 0) return 'models'
	if (profile['modelOverrides'] !== undefined) return 'modelOverrides'
	return 'empty'
}
