// tsdown 构建配置（client half 产物格式对齐官方 packages/client/tsdown.client.ts）：
//
// lib/index.js  ← src/index.ts         （node half：ESM、platform node）
// lib/client.js ← src/client.tsx       （browser half：CJS factory、platform browser）
//
// browser half 产物包成宿主 ModuleLoader factory：
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports; } });
// externals = 宿主 platform seed table（PLATFORM_MODULES）里实际 require 的行，
// 其余依赖内联——factory require 到表外 specifier 是运行期必炸错误。

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type TsdownPlugin } from 'tsdown'

const PLUGIN_ID = 'dsh-notify'

const CLIENT_EXTERNALS = new Set([
	'react',
	'react/jsx-runtime',
	'react-dom',
])

const isRequested = (specifier: string): boolean => CLIENT_EXTERNALS.has(specifier)

// ── CSS Modules 内联（移植官方 dsh-css-modules-inline 插件）────────────────
// .module.css 经 lightningcss 编译（[hash]_[local]、minify）为注入模块：
// factory 执行时写 <style data-plugin-css>（幂等），默认导出类名映射。
// 虚拟 id 不以 .css 结尾，避免被 tsdown 自身 CSS 管线截胡；宿主只加载
// lib/client.js 单文件，独立 css 产物无人加载，必须内联。
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function styleInjectionModule(fileId: string, css: string, classMap: Record<string, string>): string {
	const tagId = `${PLUGIN_ID}/${basename(fileId)}`
	const source = [
		`const css = ${JSON.stringify(css)};`,
		`const tagId = ${JSON.stringify(tagId)};`,
		'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
		'  const tag = document.createElement(\'style\');',
		`  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
		'  tag.dataset.pluginCss = tagId;',
		'  tag.textContent = css;',
		'  document.head.appendChild(tag);',
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
		const exportEntries = Object.entries(cssExports ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		for (const [local, exp] of exportEntries) classMap[local] = exp.name
		return styleInjectionModule(fileId, code.toString(), classMap)
	},
}

export default defineConfig([
	{
		// ── node half（host composition 加载）─────────────────────────────────
		// 运行时零导入（node:http 仅类型），宿主服务全部经注入 ctx 访问。
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
	},
	{
		// ── browser half（/plugins/<id>/client.js，ModuleLoader factory）──────
		name: `${PLUGIN_ID}/client`,
		entry: { client: 'src/client.tsx' },
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
			// 打包校验白名单：本插件 client 无第三方运行时依赖，任何 node_modules
			// 内联都会在构建期报错，而不是运行期 factory 必炸。
			onlyBundle: [],
		},
		define: {
			'process.env.NODE_ENV': JSON.stringify('production'),
			'import.meta.env.MODE': JSON.stringify('production'),
			'import.meta.env': JSON.stringify({ MODE: 'production' }),
		},
		plugins: [cssModulesInline],
		outputOptions: {
			entryFileNames: 'client.js',
			banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
			intro: 'var module = { exports: {} }; var exports = module.exports;',
			footer: 'return module.exports; } });',
		},
	},
])
