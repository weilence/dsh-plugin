# 架构与构建

本文件承载双 half 架构与共享代码 / 内联机制，只写机制与成因；规则条目（一包一行、外置规则、`id` = 包名）以根 AGENTS.md「强制约定」为准，本文不重复条目。

## 双 half 架构

每个插件是一个 npm 包，在 loader 树里占**一条以包名为 name 的插件行**（`cordis.patch.yml` 的 insert）：

- **host half**：`src/index.ts`，node 侧 `apply(ctx)`，经 `ctx.webServer.register` 注册同源 HTTP 路由。
- **client half**：`src/client.tsx`（dsh-models 为 `src/client/index.ts`），浏览器侧经 `ctx.slots` 注入设置页面板；host-only 插件可以没有 client half，构建工厂以缺省 `client` 项识别。
- `package.json` 的 `dsh.client` 声明浏览器名录（platform / inject），`dsh.bundle.patch` 指向组合包 patch。
- 一包一条行的成因：子路径行（`pkg/sub`）永远不承载 client bundle，再出现第二条同名行会让宿主 client-modules 组合直接失败。
- 浏览器插件名录由 dsh-client-modules 扫描**已激活**插件行的 `dsh.client` 声明生成——client bundle 进 boot 以行激活为前提，host half 接近 no-op 的 dsh-notify 即靠此形态存活。
- 生效边界：host half 变更需重启宿主（Node ESM 缓存按 URL 命中）；client half 刷新页面即生效。
- host half 的同源路由校验与 JSON 读写统一走 `@dsh-plugins/shared/http`；有面板 API 的插件 client 侧封装统一走 `@dsh-plugins/shared/api`，以自定义请求头区分子协议（`x-dsh-mcp` / `x-dsh-skills` / `x-dsh-remote`）；host↔client 的 wire 类型与常量按惯例集中放 `src/shared.ts`。
- host half 是宿主侧受信代码：用户从设置页发起的文件与子进程操作直接用 node 能力（`node:fs` / `node:child_process`），不受模型沙箱策略约束。
- 构建只声明差异点：`tsdown.config.ts` 走 `@dsh-plugins/tsdown-config` 的 `defineDshPluginConfig`。产物 `lib/index.js`（node，ESM）+ `lib/client.js`（浏览器 ModuleLoader factory），`lib/` 不入库。

## 共享代码与内联机制

- `packages/*` 的 exports 直指 `./src/*.ts`：构建期经 workspace symlink 解析为仓库相对路径**直接内联**，不经过 `bundle` 白名单门禁，也永远不是运行时依赖——新共享包参照 `client-ui` / `shared` 的 manifest 形态即可。
- `host.bundle` / `client.bundle` 名单（tsdown 的 `onlyBundle`）是**构建期校验门禁，不是内联指令**：tsdown 默认外置 `dependencies` 与 `peerDependencies`，生产依赖保持外置、运行期由已安装插件自带的 node_modules 解析；能进产物的第三方包只走 devDependencies + 名单这一条通道（各插件 host half 内联 `yaml` 是先例）。`@deepseek-ai/*` 平台包运行期由宿主解析——client 产物的 `require` 只能命中宿主模块表，混入即启动失败（实际发生过：dayjs 误声明为 dependencies）。
- `tsdown.config.ts` 的 `id` 是 client bundle 的 `ModuleLoader.load({ id })` 注册键：宿主按运行时包名组装 entry 图并取 `/plugins/<id>/` bundle，`id` 与 package.json `name` 不一致就无法匹配注册。
- 跨插件工具进 `@dsh-plugins/shared`（导出面：`.` 同构 errMsg、`./http` host 请求校验、`./api` client 侧 HTTP 封装、`./patch` patch 文档编辑原语、`./remote` 跨插件远端传输契约），在 `packages/shared/test/` 配单测；各插件内不再复制这些函数。
