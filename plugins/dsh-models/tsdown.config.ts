// dsh-models 构建配置——只声明差异点，公共双 half 构建逻辑见
// @dsh-plugins/tsdown-config（packages/tsdown-config/src/index.ts）。

import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
	id: 'dsh-models',
	clientEntry: 'src/client/index.ts',
	// 宿主 seed 表额外提供的 client 运行时依赖（UI 原语库）。
	clientExternals: ['@deepseek-ai/dsh-client-ui-primitives'],
	// Host DSH imports are type-only; bundle only the small home-path helper.
	nodeDeps: { bundle: ['@deepseek-ai/dsh-home-paths'] },
	// client 内联 yaml 的浏览器 ESM 构建（Node 版 require process/buffer，浏览器
	// ModuleLoader 的 require 不认这两个词）——详见工厂内注释。
	yamlBrowserEntry: true,
})
