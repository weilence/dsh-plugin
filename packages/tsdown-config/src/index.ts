import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type TsdownPlugin } from 'tsdown'

export interface DshPluginHalfOptions {
  entry?: string
  external?: string[]
  bundle?: string[]
}

export interface DshPluginBuildOptions {
  id: string
  client: DshPluginHalfOptions
  host?: DshPluginHalfOptions
}

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

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
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = Object.fromEntries(
        Object.entries(cssExports ?? {})
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([local, exp]) => [local, exp.name] as const),
      )
      const tagId = `${pluginId}/${relative(process.cwd(), fileId).replace(/\\/g, '/')}`
      return `const css = ${JSON.stringify(code.toString())};
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
    },
  }
}

// client 基座 external，对齐 DSH 宿主 seed 表（packages/client/web/src/platform.ts）
const PLATFORM_CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

export function defineDshPluginConfig(options: DshPluginBuildOptions) {
  const { id, client, host } = options

  const clientExternalsSet = new Set([...PLATFORM_CLIENT_EXTERNALS, ...(client.external ?? [])])
  const hostExternalSet = new Set(host?.external ?? [])

  return defineConfig([
    {
      name: id,
      entry: { index: host?.entry ?? 'src/index.ts' },
      outDir: 'lib',
      format: 'esm',
      platform: 'node',
      target: 'es2024',
      fixedExtension: false,
      dts: false,
      sourcemap: false,
      clean: false,
      deps: {
        neverBundle: (specifier: string) => hostExternalSet.has(specifier),
        onlyBundle: host?.bundle,
      },
    },
    {
      name: `${id}/client`,
      entry: { client: client.entry ?? 'src/client.tsx' },
      outDir: 'lib',
      format: 'cjs',
      platform: 'browser',
      target: 'es2024',
      dts: false,
      sourcemap: true,
      clean: false,
      deps: {
        neverBundle: (specifier: string) => clientExternalsSet.has(specifier),
        onlyBundle: client.bundle,
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        'import.meta.env.MODE': JSON.stringify('production'),
        'import.meta.env': JSON.stringify({ MODE: 'production' }),
      },
      inputOptions: {
        resolve: {
          conditionNames: ['production', 'browser', 'import', 'module', 'default'],
        },
      },
      plugins: [cssModulesInline(id)],
      outputOptions: {
        entryFileNames: 'client.js',
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
        intro: 'var module = { exports: {} }; var exports = module.exports;',
        footer: 'return module.exports; } });',
      },
    },
  ])
}
