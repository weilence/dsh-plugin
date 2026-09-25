// tsdown 构建配置（client half 产物格式对齐官方 packages/client/tsdown.client.ts）：
//
// lib/index.js  ← src/index.ts         （node half：ESM、platform node）
// lib/client.js ← src/client/index.ts  （browser half：CJS factory、platform browser）
//
// browser half 产物包成宿主 ModuleLoader factory：
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports; } });
// externals = 宿主 platform seed table（PLATFORM_MODULES）里实际 require 的行，
// 其余依赖内联——factory require 到表外 specifier 是运行期必炸错误。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type TsdownPlugin } from 'tsdown'

const PLUGIN_ID = 'dsh-models'

const CLIENT_EXTERNALS = new Set([
	'react',
	'react/jsx-runtime',
	'react-dom',
	'@deepseek-ai/dsh-client-ui-primitives',
])

const isRequested = (specifier: string): boolean => CLIENT_EXTERNALS.has(specifier)

// ── CSS Modules 内联（移植官方 dsh-css-modules-inline 插件）────────────────
// .module.css 经 lightningcss 编译（[hash]_[local]、minify）为注入模块：
// factory 执行时写 <style data-plugin-css>（幂等），默认导出类名映射。
// 虚拟 id 不以 .css 结尾，避免被 tsdown 自身 CSS 管线截胡；宿主只加载
// lib/client.js 单文件，独立 css 产物无人加载，必须内联。
/**
 * `yaml` 的 package exports 把 "node" 条件排在 "default" 之前，rolldown 在
 * CJS/browser 目标下会解析到 Node 版（`dist/log.js` require("process")、
 * `schema/yaml-1.1/binary.js` require("buffer")），而浏览器 ModuleLoader 的
 * require 只认平台 seed 表，这两个词不在表里。`browser` 字段在 CJS 目标下也
 * 不被消费，因此在解析阶段直接把裸 specifier 指向它的浏览器 ESM 构建。
 */
const yamlBrowserEsm = fileURLToPath(new URL('./node_modules/yaml/browser/dist/index.js', import.meta.url))
const yamlBrowserOnly: TsdownPlugin = {
	name: 'dsh-models/yaml-browser-entry',
	resolveId(source) {
		return source === 'yaml' ? yamlBrowserEsm : null
	},
}

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function styleInjectionModule(fileId: string, css: string, classMap: Record<string, string>): string {
	const tagId = `${PLUGIN_ID}/${basename(fileId)}`
	const source = [
		`const css = ${JSON.stringify(css)};`,
		`const tagId = ${JSON.stringify(tagId)};`,
		"if (typeof document !== 'undefined') {",
		// 幂等键是文件名，但命中已有标签时必须「更新内容」而不是跳过：
		// 否则 HMR / 热更新后页面会停留在旧样式上（JSX 新、CSS 旧，
		// 类名映射与规则对不上，布局错乱）。创建后每次执行都重写 textContent。
		"  let tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']');",
		'  if (tag === null) {',
		"    tag = document.createElement('style');",
		`    tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
		'    tag.dataset.pluginCss = tagId;',
		'    document.head.appendChild(tag);',
		'  }',
		'  tag.textContent = css;',
		'}',
		`export default ${JSON.stringify(classMap)};`,
	]
	return source.join('\n')
}

const cssModulesInline: TsdownPlugin = {
	name: 'dsh-css-modules-inline',
	resolveId(source: string, importer?: string) {
		if (!source.endsWith('.module.css')) return null
		const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
		return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
	},
	async load(virtualId: string) {
		if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
		const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
		// 虚拟 id 把物理样式表藏出 rolldown 的 watch 图，显式登记。
		this.addWatchFile(fileId)
		const source = await readFile(fileId)
		const { code, exports: cssExports } = transform({
			filename: fileId,
			code: source,
			cssModules: { pattern: '[hash]_[local]' },
			minify: true,
		})
		const classMap: Record<string, string> = {}
		const exportEntries = Object.entries(cssExports ?? {}).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		)
		for (const [local, exp] of exportEntries) classMap[local] = exp.name
		return styleInjectionModule(fileId, code.toString(), classMap)
	},
}

export default defineConfig([
	{
		// ── node half（host composition 加载）─────────────────────────────────
		name: PLUGIN_ID,
		entry: { index: 'src/index.ts' },
		outDir: 'lib',
		format: 'esm',
		platform: 'node',
		target: 'es2024',
		fixedExtension: false,
		dts: false,
		sourcemap: false,
		// lib/ 里两个 half 共存于一次构建，绝不能 clean（否则相互覆盖）。
		clean: false,
		deps: {
			// Host DSH imports are type-only; bundle only the small home-path helper.
			neverBundle: (specifier) => false,
			alwaysBundle: (specifier) => !specifier.startsWith('node:'),
			onlyBundle: ['@deepseek-ai/dsh-home-paths'],
		},
	},
	{
		// ── browser half（/plugins/<id>/client.js，ModuleLoader factory）──────
		name: `${PLUGIN_ID}/client`,
		entry: { client: 'src/client/index.ts' },
		outDir: 'lib',
		format: 'cjs',
		platform: 'browser',
		target: 'es2024',
		dts: false,
		sourcemap: true,
		clean: false,
		deps: {
			neverBundle: isRequested,
			alwaysBundle: (specifier) => !isRequested(specifier),
		},
		define: {
			'process.env.NODE_ENV': JSON.stringify('production'),
			'import.meta.env.MODE': JSON.stringify('production'),
			'import.meta.env': JSON.stringify({ MODE: 'production' }),
		},
		plugins: [yamlBrowserOnly, cssModulesInline],
		outputOptions: {
			entryFileNames: 'client.js',
			banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
			intro: 'var module = { exports: {} }; var exports = module.exports;',
			footer: 'return module.exports; } });',
		},
	},
])
