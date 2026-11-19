import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  // id 恒等于 package.json name（宿主 loader 的插件注册键）
  id: '@weilence/dsh-zhipu-tools',
  // host-only 插件：不产出 client bundle（package.json 相应不声明 dsh.client）。
  // 无需内联第三方包：MCP SDK 走生产依赖随 npm 安装解析，
  // cordis / cosmokit / @deepseek-ai/* 由宿主供给自动外置。
})
