# dsh-plugins

面向在本仓库工作的 coding agent。面向用户的文档（各插件的功能与安装）见根与插件 README；**修改 `plugins/<name>/` 下的代码前，先读该目录的 AGENTS.md**。

## 仓库布局

- `plugins/<name>/`：七个可发布 npm 插件（目录与包名——`dsh-mcp`→`@weilence/dsh-mcp`、`dsh-models`→`@weilence/dsh-models`、`dsh-notify`→`@weilence/dsh-notify`、`dsh-prompts`→`@weilence/dsh-prompts`、`dsh-skills`→`@weilence/dsh-skills`、`dsh-zhipu-tools`→`@weilence/dsh-zhipu-tools`、`dsh-remote`→`@weilence/dsh-remote`），独立版本、独立发布；包名统一 `@weilence/*` scope（weilence.com 域名空间；无 scope 的包名 `dsh-remote` 曾被 npm 第三方包占用）。
- `packages/`：私有 workspace 源码包，不发布——`tsdown-config`（双 half 构建工厂）、`client-ui`（共享 client UI 组件）、`shared`（host 请求校验 / errMsg / client 侧 HTTP 封装 / patch 文档编辑原语）。
- `pnpm-workspace.yaml`：catalog 共享版本表；`tsconfig.base.json`：公共编译配置。
- 跨插件耦合的事实改动须双侧同步：智谱凭据的解析顺序（`ZAI_CODING_CN_API_KEY` 缺席时尝试 `ZAI_API_KEY`）同时实现于 dsh-zhipu-tools（搜索 provider）与 dsh-models（用量适配）。

## 双 half 架构

每个插件是一个 npm 包，在 loader 树里占**一条以包名为 name 的插件行**（`cordis.patch.yml` 的 insert）：

- **host half**：`src/index.ts`，node 侧 `apply(ctx)`，经 `ctx.webServer.register` 注册同源 HTTP 路由。
- **client half**：`src/client.tsx`（dsh-models 为 `src/client/index.ts`），浏览器侧经 `ctx.slots` 注入设置页面板。
- `package.json` 的 `dsh.client` 声明浏览器名录（platform / inject），`dsh.bundle.patch` 指向组合包 patch。
- 一个包只能占一条以包名为 name 的行：子路径行（`pkg/sub`）永远不承载 client bundle，再出现第二条同名行会让宿主 client-modules 组合直接失败。
- client bundle 进 boot 的前提是宿主 Loader 已激活该包的插件行：浏览器插件名录由 dsh-client-modules 扫描已激活条目的 `dsh.client` 声明生成——host half 即使功能上 no-op 也不得删行（dsh-notify 即此形态）。
- 生效边界：host half 变更需重启宿主（Node ESM 缓存按 URL 命中）；client half 刷新页面即生效。
- host half 的同源路由校验与 JSON 读写统一走 `@dsh-plugins/shared/http`；有面板 API 的插件 client 侧封装统一走 `@dsh-plugins/shared/api`，以自定义请求头区分子协议（`x-dsh-mcp` / `x-dsh-skills` / `x-dsh-remote`）；host↔client 的 wire 类型与常量按惯例集中放 `src/shared.ts`。
- host half 是宿主侧受信代码：用户从设置页发起的文件与子进程操作直接用 node 能力（`node:fs` / `node:child_process`），不受模型沙箱策略约束。
- 构建只声明差异点：`tsdown.config.ts` 走 `@dsh-plugins/tsdown-config` 的 `defineDshPluginConfig`。产物 `lib/index.js`（node，ESM）+ `lib/client.js`（浏览器 ModuleLoader factory），`lib/` 不入库。

## 多语言约定

全部用户可见文案跟随宿主语言，语言选择与回退只有宿主 locale 服务一个事实源，插件不自建语言状态：

- 每个插件在自己的 `src/client/locales.ts` 持有词典：命名空间为插件 id（如 `dsh-models`），zh 是键集事实源（扁平点分键、`{param}` 插值、`as const`），`en` 逐键补全（编译期查全），`declare module '@deepseek-ai/dsh-client-ui-slots'` 合并进 `LocaleNamespaceMap`。
- client `apply` 里 `ctx.effect(() => ctx.locale.register(NS, { zh, en }), …)` 注册，`const t = ctx.locale.bind(NS)` 绑定；`settings.section` 导航 label 必须是 **thunk**（`label: () => t('section.label')`，写 `label: t('…')` 会在注册时定格）；面板经 inject 面接收 `t`。取消 / 关闭等公共词直接用 common 词条（`t('cancel')`、`t('close')`），不自造重复键。
- 组件 props 的 `t` 用本插件窄类型（`TranslateNS<typeof NS>`），不要用宽域 `Translate`——函数参数逆变，窄域不可赋给宽域；单测取词用各包 `test/i18n.ts` 的 `makeT`（与宿主同一种插值语义，common 词条按需快照）。
- 跨语言切换须存活的提示 / 错误（store 状态）用消息描述子 `{key, params} | {text}`，渲染期取词；Host errMsg 等外部事实一律 `{text}` 原样展示，不翻译不吞。即显一次性反馈（Toast、fetchStatus）允许事件时间取词。
- Host↔client 传**语义不传文案**：可识别失败用稳定原因码（如 dsh-models 用量的 `UsageFailureCode`），client 按码翻译摘要并保留安全的原始详情；请求与语言解耦，切换语言不重新发请求。
- 共享 `Dialog` / `ConfirmDialog` 不内嵌文案：`closeLabel`（与 `cancelLabel`）是必填 props，由调用方传 `t('close')` / `t('cancel')`。

## 两层用户 patch 约定

写用户层配置的插件（dsh-mcp / dsh-zhipu-tools；dsh-remote 在远端做同类合并）共用这一机制：

- 写入目标是两层用户 patch：profile 层 `<profile>/cordis.patch.yml` 与 home 层 `$DSH_HOME/cordis.patch.yml`，按官方语义 fold（后层覆盖前层；bundle / `--patch` 引入的行只读）；patch 行的 `config` 是整体替换，不做深合并。
- patch 文件编辑一律保留用户注释与无关行（Document / 行级 round-trip），不走字符串拼接重建。
- 生效链路：写盘 → HMR patch watcher 在线重整，宿主未启用 HMR 时需重启；写操作后面板补偿刷新两次（约 1.2s / 4s），覆盖 watcher → 重挂载的窗口期。

## 共享代码与内联机制

- `packages/*` 的 exports 直指 `./src/*.ts`：构建期经 workspace symlink 解析为仓库相对路径**直接内联**，不经过 `bundle` 白名单门禁，也永远不是运行时依赖——新共享包参照 `client-ui` / `shared` 的 manifest 形态即可。
- `host.bundle` / `client.bundle` 名单（tsdown 的 `onlyBundle`）只是**构建期校验门禁，不是内联指令**：tsdown 默认外置 `dependencies` 与 `peerDependencies`，要内联进产物的第三方包必须声明在 `devDependencies` 并列入对应名单（如各插件 host half 内联 `yaml`）；生产依赖保持外置，运行期由已安装插件自带的 node_modules 解析。`@deepseek-ai/*` 平台包一律外置，运行期由宿主解析——client 产物的 `require` 只能命中宿主模块表，外置依赖混进 client 产物会启动即失败（实际发生过：dayjs 误声明为 dependencies）。
- `tsdown.config.ts` 的 `id` 必须恒等于 package.json `name`：它是 client bundle 的 `ModuleLoader.load({ id })` 注册键，宿主按运行时包名组装 entry 图并取 `/plugins/<id>/` bundle，两者不一致则无法匹配注册。
- 跨插件工具进 `@dsh-plugins/shared`（四面导出：`.` 同构 errMsg、`./http` host 请求校验、`./api` client 侧 HTTP 封装、`./patch` patch 文档编辑原语），在 `packages/shared/test/` 配单测；各插件内不再复制这些函数。

## 版本与发布陷阱

- `peerDependencies` 必须写**字面 semver range**（如 `>=0.2.0-rc.1 <0.3.0`），不能写 `catalog:`——宿主 app-boot 的兼容性预检对字符串直接做 `semver.satisfies`，无效范围会让宿主拒绝加载插件。
- 凡 DSH 自带包（`@deepseek-ai/*`）在 `dependencies` / `devDependencies` 里一律以 `"catalog:"` 引用，插件不得自行锁版本——平台包必须同版本协同，升级 DSH 平台只改 `pnpm-workspace.yaml` 的 catalog 一处；第三方库不进 catalog，由使用的插件自行声明。
- 提交前运行全量验证（与 CI 相同的四项检查）：`pnpm -r typecheck && pnpm -r test && pnpm -r build && pnpm format:check`。
- 发布：改插件 version → `git tag @weilence/<目录>/vX.Y.Z` → push；CI 暂存发布后 `npm stage approve` 上线（`.github/workflows/publish.yml`）。新 scope 各包首发需手动 `npm publish` 一次。

## 沙箱权限拦截

- 开发中撞上沙箱导致的权限拦截（spawn 系统工具被禁、文件访问被拒等）：停下来向用户报告被拦的具体操作与影响，由用户决定放开开发权限还是走替代方案——禁止未经确认把沙箱迁就写进代码或测试（抽纯函数替身、加环境分支、换次优实现）；开发环境的限制不是产品需求（实际发生过：测试沙箱禁 ps spawn，为绕开抽了纯函数替身测试，事后整体回退）。

## 代码与提交风格

- 注释中文、写 why 不写 what、落在实现处；删非必要注释与单用途间接层，优先命名与官方包类型，不建本地镜像。
- 官方服务面一律直接使用官方包类型（type-only 导入，如 `LocaleRuntime`），**禁止手写结构化投影接口**——镜像在官方类型演进时没有编译期警告，漂移只在运行期暴露。
- prettier：无分号、单引号、行宽 110（`pnpm format`）。
- 提交信息：Conventional 类型 + 中文主题，如 `feat(dsh-skills): 设置页「Skills 管理」插件`。

## 面板交互约定

- 用户可能引用的可见文本（URL、端点、id、路径、错误详情）一律可选中复制；与整行点击展开 / 拖拽排序的冲突用手势仲裁解决（按按下点判定归属），不得靠禁用文本选择迁就。
- 弹窗取数（如远端清单）先与本地对比，再一次性渲染出列表，不先短暂显示旧默认值再跳变。
- 破坏性操作必须基于已确认的事实：依赖的状态读不到就禁用操作并给出原因，绝不假设执行。
- 写用户数据一律双保险：携带读取时的版本做乐观并发（如 `settings.mutate` 带 revision、全局提示词带内容版本），冲突后不得盲目覆盖；文件落盘一律 tmp+mv 原子替换。
- 操作入口一律常驻：前置条件不满足时禁用并给出原因，或点击后提示所缺的前提（如插件同步需先连接远端）；随阶段切换的只是可用动作，不是入口的有无。
- 提交 / 保存类校验与失败反馈渲染在动作按钮旁（底部动作区上方），不放表单顶部——长表单时顶部的提示区在视口外，用户点了保存看不见被拦的原因。
- 设置分区需要更宽弹窗时用 `@dsh-plugins/client-ui` 的 `useWideSettingsDialog()`——官方设置弹窗固定 800×800 且无尺寸 API；分区挂载期间生效、卸载即还原。

## 测试约定

- 每包独立 vitest，无全局配置：`pnpm --filter <pkg> test`。
- host 路由测试用假 `ctx` / `webServer` + fake req/res 桩走完整的请求-响应链路（范本：各插件 `test/host.test.ts`）；`@dsh-plugins/shared/http` 的请求校验纯函数在 shared 包直接单测。
- 官方契约类型一律 type-only 导入（`import type {} from '@deepseek-ai/…'` 声明合并进 `Context`），编译产物保持零运行时导入。
