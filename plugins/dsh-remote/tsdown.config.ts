import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

// host half 把 yaml 内联进产物（远端 patch 的 cat→改→cat 合并需要）：
// profile 的 node_modules 里没有该包，运行时不能依赖宿主解析。
export default defineDshPluginConfig({
  // id 必须恒等于 package.json name：它是 client bundle 的 ModuleLoader 注册键，
  // 宿主按运行时包名组 entry 图并取 /plugins/<id>/ bundle，失配则无法匹配注册。
  id: '@weilence/dsh-remote',
  host: { bundle: ['yaml'] },
  client: {},
})
