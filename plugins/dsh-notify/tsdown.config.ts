// dsh-notify 构建配置——只声明差异点，公共双 half 构建逻辑见
// @dsh-plugins/tsdown-config（packages/tsdown-config/src/index.ts）。

import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
	id: 'dsh-notify',
	clientEntry: 'src/client.tsx',
	// 打包校验白名单：本插件 client 无第三方运行时依赖，任何 node_modules
	// 内联都会在构建期报错，而不是运行期 factory 必炸。
	clientOnlyBundle: [],
})
