import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

// host half 内联 yaml（devDependency，编辑 patch 文件用，运行期不可解析）；
// cross-spawn 是生产依赖，tsdown 自动外置、由已安装插件自带的 node_modules 解析
// ——名单只是内联门禁，不是内联指令。
export default defineDshPluginConfig({
  // id 恒等于 package.json name（client bundle 的 ModuleLoader 注册键）
  id: '@weilence/dsh-mcp',
  host: { bundle: ['yaml'] },
  client: {},
})
