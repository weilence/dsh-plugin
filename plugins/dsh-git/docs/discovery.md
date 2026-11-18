# dsh-git 仓库发现

本文件承载 dsh-git 仓库发现的规格与陷阱、取舍：仓库判定与扫描、定位、路由 wire 契约、目录右键菜单、仓库面板；提交历史见 [docs/history.md](history.md)，测试覆盖见 [docs/tests.md](tests.md)。

## 定位

- 右侧栏「Git 仓库」标签：递归发现当前会话目录下的全部 Git 仓库，在仓库间切换浏览 GitLens 风格的泳道式提交历史——目录本身不是 Git 仓库也能找到子目录里的仓库。
- 仓库发现链路纯读文件系统（不依赖 git 二进制）；分支与远端摘要读自 `.git/HEAD` 与 `.git/config` 静态内容，不执行 `git status` 类动态查询；剪枝目录内部的仓库不会被列出。

## 结构导览

- `src/index.ts`：host half，`apply` 注册 repos / locate 路由与目录右键菜单（log / files 链路实现见 docs/history.md）。
- `src/scan.ts`：仓库扫描与三类判定（`scanGitRepositories`、`PRUNED_DIRS`）、逐级上探定位（`locateGitRepository`）。
- `src/shared.ts`：host 与 client 共用的路由常量与 wire 类型（与提交历史共用）。
- `src/client.tsx`：client half，两段式注册（标签类型 + keyed 槽位标签体）。
- `src/client/ReposBody.tsx`：仓库面板主体（扫描、仓库选择、头部控件、提交行与展开详情的容器）。
- `src/client/ReposBody.module.css`：仓库面板样式。
- `src/client/contextOpen.ts`：目录右键菜单的一次性待应用选择 store（版本递增）。
- `src/client/api.ts`：client 侧经 `@dsh-plugins/shared/api` 对 host 四条路由的请求封装（与提交历史共用）。

## 仓库判定与扫描

- 三类判定：目录含 `.git` 目录（standard）；含 `.git` 文件（linked，按 `gitdir:` 指针解析真实 git 目录，相对 / 绝对路径均可）；目录直接含 HEAD + objects + refs（bare）。
- 分支解析 `HEAD`（`ref: refs/heads/` 前缀剥离；detached 40 位十六进制给短提交号）；远端解析 `config` 的 `[remote "origin"]` url；扫描发现链路全部读文件、不 spawn git（见 [AGENTS.md](../AGENTS.md)「数据链路分界」）。
- 扫描语义：发现仓库后继续下探工作树（能发现嵌套仓库与子模块），但不进入 `.git` 内部、剪枝目录（`node_modules` 等，`scan.ts` 的 `PRUNED_DIRS`）与裸仓库内部；符号链接目录不跟随（dirent 判定天然如此）。
- 深度 / 目录 / 仓库三上限（默认 6 / 20 000 / 500）超限置 `truncated`；深度之外未访问不算截断。
- `relPath` 是 wire / 展示字段，统一 `/` 分隔：`path.relative` 结果 `split(sep).join('/')`（Windows 产出 `\` 须规范化，为何不可替换字面反斜杠见下方「陷阱」）。
- 定位（`scan.ts` 的 `locateGitRepository`）：自 dir 逐级上探至 cwd 为止，判定与扫描同口径，不递归下探——目录右键菜单 resolve 专用，避免右键触发整树扫描。

## 路由与 wire 契约

- 四条路由：`POST /plugins/dsh-git/repos`（扫描）、`POST /plugins/dsh-git/log`（提交图）、`POST /plugins/dsh-git/files`（单提交文件变更）、`POST /plugins/dsh-git/locate`（定位）。
- guard 模式与 dsh-sessions 相同：`requestRejection` + `isTrustedFetch` + `x-dsh-git: 1` 请求头。
- 目录参数先 `stat` 预检；log 的 limit 非法直接 400；files 的 hash 校验 4–40 位十六进制。
- host 与 client 的路由常量和 wire 类型集中在 `src/shared.ts`；client 侧封装在 `src/client/api.ts`（请求头区分子协议的机制见根 docs/architecture.md）。
- locate 入参 `{cwd, dir}` → `{repoRoot}`；dir 越出 cwd 或链上无仓库返回 `repoRoot: null`（200，动作不显示）。

## 目录右键菜单与定位

- 宿主 0.2.2 `contextMenus` 缝（`ctx.contextMenus.register`，target `directory`）；全仓插件的 `engines.dsh` 已统一为 `>=0.2.2-rc.5 <0.3.0`（随平台版本协同升级，2026-11-18 起），该要求随之覆盖；版本与 catalog 规则见根 docs/release.md。
- resolve：经 `ctx.sessions.list` 快照取该会话 cwd → 调 locate → 命中即提供「查看此目录的 Git 提交历史」。
- `run` 先写 `client/contextOpen.ts` 的模块 store（版本递增的一次性待应用选择）再 `ctx.sidebarRight.openTab(GIT_KIND)`；ReposBody 在扫描结束（或失败）后应用一次并按版本消费（仓库缺席 / 会话不符也消费，避免迟到旧值覆盖手选）；标签体可能因 openTab 才挂载，store 是菜单动作与挂载体之间唯一的传递通道。
- 菜单 label 是事件时间取词。

## 仓库面板（ReposBody）

- 两段式注册：标签类型进 `ctx.sidebarRightTabs.register`（`extension` 优先带缺省，指南入口 order 40 排在官方 files / terminal / browser 之后）；标签体进 keyed 槽位 `sidebar.right.pane.tab`（key = 类型 id `@weilence/dsh-git`）。
- 扫描根取 `PropsRuntime` 标准份额 `sessionId` 对应的 `SessionSummary.cwd`；无 cwd 显示原因、不发请求；扫描与读提交各自以序号防串台。
- 仓库选择默认「会话目录所在仓库 → 首个仓库」；重扫后选中仓库消失则回落，未消失不换。
- 头部控件：仓库下拉（底色 `bg-layer-3` 与面板区分）、「显示作者 / 时间」勾选（默认不勾）、刷新按钮（同时重扫仓库与重读提交图）。
- 头部摘要：仓库根路径与当前分支不显示（下拉已含仓库名与相对路径，分支在提交图 HEAD 芯片可见）；仅非标准形态（裸仓库 / 关联工作树）显示形态标记行。
- `formatTime` 与 `formatRelative` 注入 ReposBody（均事件时间取词，跟随宿主语言；后者用 `Intl.RelativeTimeFormat`）。
- 空仓库显示空态；git 不可用、非 git 目录等失败原因行内常驻展示。
- `@deepseek-ai/dsh-client-ui-sidebar-right` 在 `pnpm-workspace.yaml` catalog 中随平台版本升级（插件 devDependencies 一律 `catalog:`，见根 docs/release.md）。

## 陷阱

- `relPath` 规范化只能 `split(sep).join('/')`，不可对字符串替换字面反斜杠——POSIX 上反斜杠是合法文件名字符，字面替换会破坏路径。
- 扫描发现链路不得 spawn git（见 [AGENTS.md](../AGENTS.md)「数据链路分界」）。
- 事件时间取词的固定点位：目录右键菜单 label、`formatTime` / `formatRelative`——取词时机写错文案会定格（机制见根 docs/i18n.md）。

## 取舍

- 扫描语义：发现仓库后**继续下探**工作树（能发现嵌套仓库与子模块），但不进入 `.git` 内部、剪枝目录与裸仓库内部；深度之外未访问不算截断——用户已确认。
- 头部摘要：仓库根路径与当前分支不显示（下拉已含仓库名与相对路径，分支在提交图 HEAD 芯片可见）——用户已确认。
- `engines.dsh` 统一 `>=0.2.2-rc.5 <0.3.0`（2026-11-18 起随平台版本协同升级）：`contextMenus` 缝自宿主 0.2.2 起提供的要求随之覆盖。
