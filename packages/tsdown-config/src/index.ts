// DSH web 插件共享 tsdown 构建工厂——各插件的 tsdown.config.ts 只声明差异点：
//
//   export default defineDshPluginConfig({ id: 'dsh-xxx', clientEntry: 'src/client.tsx', ... })
//
// 产物格式对齐官方 packages/client/tsdown.client.ts：
//   lib/index.js  ← src/index.ts         （node half：ESM、platform node）
//   lib/client.js ← clientEntry（.tsx）  （browser half：CJS factory、platform browser）
//
// browser half 产物包成宿主 ModuleLoader factory：
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports; } });
// externals = 宿主 platform seed table（PLATFORM_MODULES）里实际 require 的行，
// 其余依赖内联——factory require 到表外 specifier 是运行期必炸错误。

import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type TsdownPlugin } from 'tsdown'

// ── 对外选项 ───────────────────────────────────────────────────────────────

export interface DshPluginNodeDeps {
	/**
	 * 允许内联进 node half bundle 的包（onlyBundle 白名单）；
	 * node: 内建始终外置。运行时零第三方导入的插件不需要本字段。
	 */
	bundle?: string[]
	/** 显式保持外置的包（如运行时由 profile 提供的 in-box peer）。 */
	external?: string[]
}

export interface DshPluginBuildOptions {
	/** 插件 id：ModuleLoader 注册名、样式标签命名空间。 */
	id: string
	/** browser half 入口（相对插件根目录）。 */
	clientEntry: string
	/** node half 入口（相对插件根目录），默认 src/index.ts。 */
	nodeEntry?: string
	/** 宿主 seed 表提供的 client 运行时依赖（react 系已默认包含）。 */
	clientExternals?: string[]
	/**
	 * 允许内联进 client bundle 的 node_modules 白名单：
	 * 省略 = 不设限制；[] = 禁止任何内联（推荐，误引入运行时依赖在构建期报错，
	 * 而不是运行期 factory 必炸）。
	 */
	clientOnlyBundle?: string[]
	/** node half 打包策略；省略 = 全部外置。 */
	nodeDeps?: DshPluginNodeDeps
	/**
	 * 把裸 specifier 'yaml' 解析到其浏览器 ESM 构建（经 node_modules 直链）。
	 *
	 * `yaml` 的 package exports 把 "node" 条件排在 "default" 之前，rolldown 在
	 * CJS/browser 目标下会解析到 Node 版（`dist/log.js` require("process")、
	 * `schema/yaml-1.1/binary.js` require("buffer")），而浏览器 ModuleLoader 的
	 * require 只认平台 seed 表，这两个词不在表里。`browser` 字段在 CJS 目标下
	 * 也不被消费，因此在解析阶段直接把裸 specifier 指向它的浏览器 ESM 构建。
	 */
	yamlBrowserEntry?: boolean
}

// ── CSS Modules 内联（移植官方 dsh-css-modules-inline 插件）────────────────
// .module.css 经 lightningcss 编译（[hash]_[local]、minify）为注入模块：
// factory 执行时写 <style data-plugin-css>（幂等），默认导出类名映射。
// 虚拟 id 不以 .css 结尾，避免被 tsdown 自身 CSS 管线截胡；宿主只加载
// lib/client.js 单文件，独立 css 产物无人加载，必须内联。

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function styleInjectionModule(pluginId: string, fileId: string, css: string, classMap: Record<string, string>): string {
	// tagId 含相对路径（而非 basename）：不同目录的同名 module.css 不会共用幂等标签。
	const tagId = `${pluginId}/${relative(process.cwd(), fileId).replace(/\\/g, '/')}`
	// 模板体必须顶格：缩进会原样进入生成的模块代码。
	// 幂等键是文件路径，但命中已有标签时必须「更新内容」而不是跳过：
	// 否则 HMR / 热更新后页面会停留在旧样式上（JSX 新、CSS 旧，
	// 类名映射与规则对不上，布局错乱）。创建后每次执行都重写 textContent。
	return `const css = ${JSON.stringify(css)};
const tagId = ${JSON.stringify(tagId)};
if (typeof document !== 'undefined') {
  let tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']');
  if (tag === null) {
    tag = document.createElement('style');
    tag.dataset.plugin = ${JSON.stringify(pluginId)};
    tag.dataset.pluginCss = tagId;
    document.head.appendChild(tag);
  }
  tag.textContent = css;
}
export default ${JSON.stringify(classMap)};`
}

function cssModulesInline(pluginId: string): TsdownPlugin {
	return {
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
			return styleInjectionModule(pluginId, fileId, code.toString(), classMap)
		},
	}
}

// ── yaml 浏览器构建重定向（见 DshPluginBuildOptions.yamlBrowserEntry 注释）──

function yamlBrowserOnly(): TsdownPlugin {
	// 以插件根（tsdown 的 cwd）解析 node_modules 直链；pnpm workspace 下直接
	// 依赖仍会 symlink 进本插件 node_modules。
	const browserEsm = resolvePath(process.cwd(), 'node_modules/yaml/browser/dist/index.js')
	return {
		name: 'dsh-plugin/yaml-browser-entry',
		resolveId(source: string) {
			return source === 'yaml' ? browserEsm : null
		},
	}
}

// ── node half 打包策略 ─────────────────────────────────────────────────────

function nodeDepsConfig(deps: DshPluginNodeDeps | undefined) {
	const bundle = deps?.bundle ?? []
	const external = new Set(deps?.external ?? [])
	if (bundle.length === 0 && external.size === 0) return undefined
	if (bundle.length > 0) {
		return {
			neverBundle: (_specifier: string) => false,
			alwaysBundle: (specifier: string) => !specifier.startsWith('node:'),
			onlyBundle: bundle,
		}
	}
	return {
		neverBundle: (specifier: string) => external.has(specifier),
		alwaysBundle: (specifier: string) => !specifier.startsWith('node:') && !external.has(specifier),
	}
}

// ── 工厂本体 ───────────────────────────────────────────────────────────────

const DEFAULT_CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom']

export function defineDshPluginConfig(options: DshPluginBuildOptions) {
	const {
		id,
		clientEntry,
		nodeEntry = 'src/index.ts',
		clientExternals = [],
		clientOnlyBundle,
		nodeDeps,
		yamlBrowserEntry = false,
	} = options

	const clientExternalsSet = new Set([...DEFAULT_CLIENT_EXTERNALS, ...clientExternals])
	const isRequested = (specifier: string): boolean => clientExternalsSet.has(specifier)

	const clientPlugins: TsdownPlugin[] = []
	if (yamlBrowserEntry) clientPlugins.push(yamlBrowserOnly())
	clientPlugins.push(cssModulesInline(id))

	const nodeDepsCfg = nodeDepsConfig(nodeDeps)

	return defineConfig([
		{
			// ── node half（host composition 加载）─────────────────────────────────
			name: id,
			entry: { index: nodeEntry },
			outDir: 'lib',
			format: 'esm',
			platform: 'node',
			target: 'es2024',
			fixedExtension: false,
			dts: false,
			sourcemap: false,
			// lib/ 里两个 half 共存于一次构建，绝不能 clean（否则相互覆盖）。
			clean: false,
			...(nodeDepsCfg === undefined ? {} : { deps: nodeDepsCfg }),
		},
		{
			// ── browser half（/plugins/<id>/client.js，ModuleLoader factory）──────
			name: `${id}/client`,
			entry: { client: clientEntry },
			outDir: 'lib',
			format: 'cjs',
			platform: 'browser',
			target: 'es2024',
			dts: false,
			sourcemap: true,
			clean: false,
			deps: {
				neverBundle: isRequested,
				alwaysBundle: (specifier: string) => !isRequested(specifier),
				...(clientOnlyBundle === undefined ? {} : { onlyBundle: clientOnlyBundle }),
			},
			define: {
				'process.env.NODE_ENV': JSON.stringify('production'),
				'import.meta.env.MODE': JSON.stringify('production'),
				'import.meta.env': JSON.stringify({ MODE: 'production' }),
			},
			plugins: clientPlugins,
			outputOptions: {
				entryFileNames: 'client.js',
				banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
				intro: 'var module = { exports: {} }; var exports = module.exports;',
				footer: 'return module.exports; } });',
			},
		},
	])
}
