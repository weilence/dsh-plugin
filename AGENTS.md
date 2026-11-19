# dsh-plugins

面向在本仓库工作的 coding agent。面向用户的文档（各插件的功能与安装）见根与插件 README；仓库与插件内部文档按渐进式发现组织：AGENTS.md 只留关键约束与文档索引，细节在 docs/——仓库级见下方文档索引，插件级在 `plugins/<name>/docs/`；**修改 `plugins/<name>/` 下的代码前，先读该目录的 AGENTS.md，行为细节按其索引读 docs/**。

**AGENTS.md 的修改合并为一次写回**：需要改动任何 AGENTS.md（根文件或各插件的）时，先把文件复制到临时目录，在副本上完成全部修改，再一次性复制回原路径——每次改动都会把整份文件重新加载进上下文，多轮零散编辑会重复消耗；单次回写只触发一次加载。

## 仓库布局

- `plugins/<name>/`：可发布 npm 插件，包名恒为 `@weilence/<目录名>`（目录名即去 scope 包名），独立版本、独立发布；插件清单以根 README 插件表为准。包名一律带 `@weilence/*` scope（weilence.com 域名空间；无 scope 的包名 `dsh-remote` 曾被 npm 第三方包占用）。
- `packages/`：私有 workspace 源码包，不发布——`tsdown-config`（双 half 构建工厂）、`client-ui`（共享 client UI 组件）、`shared`（host 请求校验 / errMsg / client 侧 HTTP 封装 / patch 文档编辑原语）。
- `pnpm-workspace.yaml`：catalog 共享版本表；`tsconfig.base.json`：公共编译配置。
- 跨插件耦合的事实改动须双侧同步：智谱凭据的解析顺序（`ZAI_CODING_CN_API_KEY` 缺席时尝试 `ZAI_API_KEY`）同时实现于 dsh-zhipu-tools（搜索 provider）与 dsh-models（用量适配）。

## 强制约定

- `plugins/<name>/` 每包在 loader 树只占**一条以包名为 name 的插件行**；host half 即使功能上 no-op 也不得删行——client bundle 进 boot 依赖宿主已激活的插件行。
- `@deepseek-ai/*` 平台包与生产依赖一律外置（运行期由宿主 / 插件自带 node_modules 解析）：client 产物的 `require` 只能命中宿主模块表，外置依赖混进 client 产物会启动即失败（实际发生过：dayjs 误声明为 dependencies）；要内联的第三方包必须声明 devDependencies 并列入 onlyBundle 名单。
- `tsdown.config.ts` 的 `id` 必须恒等于 package.json `name`——它是 client bundle 的注册键，不一致则无法匹配注册。
- 平台包一律 `"catalog:"` 引用、升级只改 `pnpm-workspace.yaml` 的 catalog 一处；插件不声明 `peerDependencies`，`engines.dsh` 必须写**字面 semver range**，不能用 `catalog:`。
- 模型工具产物按 output schema 强校验——宿主管道缺字段整个调用直接失败：新增 / 修改工具必须同步 schema 与该插件单测的形状走查器。
- 用户可见文案只走宿主 locale 服务，插件不自建语言状态；`settings.section` 导航 label 必须是 **thunk**（写 `label: t('…')` 会在注册时定格）。
- 组件间传 `t` 用窄类型 `TranslateNS<typeof NS>`，不用宽域 `Translate`（函数参数逆变，窄域不可赋给宽域）。
- patch 文件编辑一律保留用户注释与无关行（行级 round-trip），不走字符串拼接重建；patch 行 `config` 是整体替换、不做深合并。
- 写用户数据一律双保险：携带读取时的版本做乐观并发，文件落盘 tmp+mv 原子替换；破坏性操作必须基于已确认的事实。
- 操作入口一律常驻：前置条件不满足就禁用并给出原因；凡 Toast 提示——无论成功失败——显示点必须常驻：挂宿主壳层 `shell.overlay` 槽位（共享套件 `ResidentNoticeToast`），不随面板 / 弹窗卸载。成功反馈按场景可选、可以没有提示；错误与校验反馈默认行内常驻，若以 Toast 呈现失败同样走常驻显示点（细则见 [docs/panel.md](docs/panel.md)）。
- 开发中撞上沙箱权限拦截（spawn 系统工具被禁、文件访问被拒等）：停下来向用户报告被拦的具体操作与影响，禁止未经确认把沙箱迁就写进代码或测试——开发环境的限制不是产品需求（实际发生过：测试沙箱禁 ps spawn，为绕开抽了纯函数替身测试，事后整体回退）。
- 提交前必须运行与 CI 相同的四项检查：`pnpm -r typecheck && pnpm -r test && pnpm -r build && pnpm format:check`；格式化用 `pnpm format`。

## 文档索引

- [docs/architecture.md](docs/architecture.md)：双 half 架构、共享代码与内联机制（构建产物与门禁）。
- [docs/i18n.md](docs/i18n.md)：多语言约定（词典组织、locale seat、消息描述子）。
- [docs/panel.md](docs/panel.md)：面板交互约定（官方原语、字段契约、通知通道、弹窗）。
- [docs/patch.md](docs/patch.md)：两层用户 patch 约定（写入目标、round-trip、生效链路）。
- [docs/release.md](docs/release.md)：版本与发布陷阱（engines / catalog 规则背景、发布流程）。
- [docs/testing.md](docs/testing.md)：测试约定（单测 / 集成分层、运行方式）。
- [docs/code-style.md](docs/code-style.md)：结构、类型、注释、措辞、格式、提交与验证规范——必须遵循。
- 插件：`plugins/<name>/AGENTS.md`（插件关键约束与文档索引）+ `plugins/<name>/docs/`（按插件内容组织的行为规格、约束背景与测试地图等）。
