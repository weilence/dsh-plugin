import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

// 零第三方依赖：host half 只 import 宿主供给的 @deepseek-ai/* 平台包（一律
// 外置），client half 对平台包只有 type-only 引用（构建产物零运行时导入）。
export default defineDshPluginConfig({
  // id 恒等于 package.json name（client bundle 的 ModuleLoader 注册键）
  id: '@weilence/dsh-atlassian',
  host: {},
  client: {},
})
