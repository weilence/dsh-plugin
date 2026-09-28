import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

// host 半侧把 yaml 内联进产物：profile 的 node_modules 里没有该包，
// 运行时不能依赖宿主解析。
export default defineDshPluginConfig({
  // id 恒等于 package.json name（client bundle 的 ModuleLoader 注册键）
  id: '@weilence/dsh-mcp',
  host: { bundle: ['yaml'] },
  client: {},
})
