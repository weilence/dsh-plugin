import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

// host 半侧把 yaml 内联进产物（远端 patch 的 cat→改→cat 合并需要）：
// profile 的 node_modules 里没有该包，运行时不能依赖宿主解析。
export default defineDshPluginConfig({
  id: 'dsh-remote',
  host: { bundle: ['yaml'] },
  client: {},
})
