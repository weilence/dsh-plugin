// dsh-zhipu-tools 构建配置——只声明差异点，公共双 half 构建逻辑见
// @dsh-plugins/tsdown-config（packages/tsdown-config/src/index.ts）。

import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
	id: 'dsh-zhipu-tools',
	clientEntry: 'src/client.tsx',
	// 宿主 seed 表额外提供的 client 运行时依赖（UI 原语库）。
	clientExternals: ['@deepseek-ai/dsh-client-ui-primitives'],
	// 允许内联的 node_modules 依赖只有 clsx；将来误引入其他运行时依赖会在
	// 构建期报错，而不是运行期 factory 必炸。
	clientOnlyBundle: ['clsx'],
	// in-box mcp-client 是运行时 peer（profile 提供），留作外部导入。
	nodeDeps: { external: ['@deepseek-ai/dsh-mcp-client'] },
})
