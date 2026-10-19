import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  // id 恒等于 package.json name（client bundle 的 ModuleLoader 注册键）
  id: '@weilence/dsh-zhipu-tools',
  // 无需内联第三方包：MCP SDK 走生产依赖随 npm 安装解析，
  // cordis / cosmokit / @deepseek-ai/* 由宿主供给自动外置。
  client: { entry: 'src/client/index.ts' },
})
