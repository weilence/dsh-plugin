import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  // id 恒等于 package.json name（client bundle 的 ModuleLoader 注册键）
  id: '@weilence/dsh-zhipu-tools',
  // host half 内联 yaml：搜索替换开关要编辑用户 patch 文件，profile 的
  // node_modules 里没有该包。
  host: { bundle: ['yaml'] },
  client: { entry: 'src/client/index.ts' },
})
