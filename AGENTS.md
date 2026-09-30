# dsh-plugins

面向在本仓库工作的 coding agent。面向用户的文档（各插件的功能与安装）见根与插件 README；**修改 `plugins/<name>/` 下的代码前，先读该目录的 AGENTS.md**。

## 仓库布局

- `plugins/<name>/`：六个可发布 npm 插件（目录与包名——`dsh-mcp`→`@weilence/dsh-mcp`、`dsh-models`→`@weilence/dsh-models`、`dsh-notify`→`@weilence/dsh-notify`、`dsh-skills`→`@weilence/dsh-skills`、`dsh-zhipu-tools`→`@weilence/dsh-zhipu-tools`、`dsh-remote`→`@weilence/dsh-remote`），独立版本、独立发布；包名统一 `@weilence/*` scope（weilence.com 域名空间；无 scope 的包名 `dsh-remote` 曾被 npm 第三方包占用）。
- `packages/`：私有 workspace 源码包，不发布——`tsdown-config`（双 half 构建工厂）、`client-ui`（共享 client UI 组件）、`shared`（host 请求校验 / errMsg / client 侧 HTTP 封装）。
- `pnpm-workspace.yaml`：catalog 共享版本表；`tsconfig.base.json`：公共编译配置。

## 双 half 架构

每个插件是一个 npm 包，在 loader 树里占**一条以包名为 name 的插件行**（`cordis.patch.yml` 的 insert）：

- **host half**：`src/index.ts`，node 侧 `apply(ctx)`，经 `ctx.webServer.register` 注册同源 HTTP 路由。
- **client half**：`src/client.tsx`（dsh-models 为 `src/client/index.ts`），浏览器侧经 `ctx.slots` 注入设置页面板。
- `package.json` 的 `dsh.client` 声明浏览器名录（platform / inject），`dsh.bundle.patch` 指向组合包 patch。
- 一个包只能占一条以包名为 name 的行：子路径行（`pkg/sub`）永远不承载 client bundle，再出现第二条同名行会让宿主 client-modules 组合直接失败。
- 构建只声明差异点：`tsdown.config.ts` 走 `@dsh-plugins/tsdown-config` 的 `defineDshPluginConfig`。产物 `lib/index.js`（node，ESM）+ `lib/client.js`（浏览器 ModuleLoader factory），`lib/` 不入库。

## 共享代码与内联机制

- `packages/*` 的 exports 直指 `./src/*.ts`：构建期经 workspace symlink 解析为仓库相对路径**直接内联**，不经过 `bundle` 白名单门禁，也永远不是运行时依赖——新共享包参照 `client-ui` / `shared` 的 manifest 形态即可。
- `host.bundle` / `client.bundle` 白名单只针对 node_modules 依赖（如 dsh-mcp 内联 `yaml`、dsh-zhipu-tools client 内联 `clsx`）；`@deepseek-ai/*` 平台包一律外置，运行期由宿主解析。
- `tsdown.config.ts` 的 `id` 必须恒等于 package.json `name`：它是 client bundle 的 `ModuleLoader.load({ id })` 注册键，宿主按运行时包名组装 entry 图并取 `/plugins/<id>/` bundle，两者不一致则无法匹配注册。
- 跨插件工具进 `@dsh-plugins/shared`（三面导出：`.` 同构 errMsg、`./http` host 请求校验、`./api` client 侧 HTTP 封装），在 `packages/shared/test/` 配单测；各插件内不再复制这些函数。

## 版本与发布陷阱

- `peerDependencies` 必须写**字面 semver range**（如 `>=0.2.0-rc.1 <0.3.0`），不能写 `catalog:`——宿主 app-boot 的兼容性预检对字符串直接做 `semver.satisfies`，无效范围会让宿主拒绝加载插件。
- 平台包必须同版本协同；升级 DSH 平台只改 `pnpm-workspace.yaml` 的 catalog 一处。
- 提交前运行全量验证（与 CI 相同的四项检查）：`pnpm -r typecheck && pnpm -r test && pnpm -r build && pnpm format:check`。
- 发布：改插件 version → `git tag @weilence/<目录>/vX.Y.Z` → push；CI 暂存发布后 `npm stage approve` 上线（`.github/workflows/publish.yml`）。新 scope 各包首发需手动 `npm publish` 一次。

## 沙箱权限拦截

- 开发中撞上沙箱导致的权限拦截（spawn 系统工具被禁、文件访问被拒等）：停下来向用户报告被拦的具体操作与影响，由用户决定放开开发权限还是走替代方案——禁止未经确认把沙箱迁就写进代码或测试（抽纯函数替身、加环境分支、换次优实现）；开发环境的限制不是产品需求（实际发生过：测试沙箱禁 ps spawn，为绕开抽了纯函数替身测试，事后整体回退）。

## 代码与提交风格

- 注释中文、写 why 不写 what、落在实现处；删非必要注释与单用途间接层，优先命名与官方包类型，不建本地镜像。
- prettier：无分号、单引号、行宽 110（`pnpm format`）。
- 提交信息：Conventional 类型 + 中文主题，如 `feat(dsh-skills): 设置页「Skills 管理」插件`。

## 面板交互约定

- 用户可能引用的可见文本（URL、端点、id、路径、错误详情）一律可选中复制；与整行点击展开 / 拖拽排序的冲突用手势仲裁解决（按按下点判定归属），不得靠禁用文本选择迁就。
- 弹窗取数（如远端清单）先与本地对比，再一次性渲染出列表，不先短暂显示旧默认值再跳变。
- 破坏性操作必须基于已确认的事实：依赖的状态读不到就禁用操作并给出原因，绝不假设执行。
- 操作入口一律常驻：前置条件不满足时禁用并给出原因，或点击后提示所缺的前提（如插件同步需先连接远端）；随阶段切换的只是可用动作，不是入口的有无。

## 测试约定

- 每包独立 vitest，无全局配置：`pnpm --filter <pkg> test`。
- host 路由测试用假 `ctx` / `webServer` + fake req/res 桩走完整的请求-响应链路（范本：各插件 `test/host.test.ts`）；`@dsh-plugins/shared/http` 的请求校验纯函数在 shared 包直接单测。
- 官方契约类型一律 type-only 导入（`import type {} from '@deepseek-ai/…'` 声明合并进 `Context`），编译产物保持零运行时导入。
