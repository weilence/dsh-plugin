# 功能与行为规格（@weilence/dsh-skills）

本文件承载插件的功能与行为规格（是什么 / 怎么表现）：插件定位、结构导览、扫描 / 校验 / frontmatter round-trip / Git 安装更新链路、面板行为语义；易错点见 [traps.md](traps.md)，决策理由见 [decisions.md](decisions.md)，测试见 [tests.md](tests.md)。

## 插件定位

- 侧栏「Skills 管理」全局面板插件：直接扫描四个标准技能根（与官方 skill-filesystem provider 同一套发现与校验规则）再合并全局注册表的只读来源；对可写根新建 / 编辑 / 删除，Git 仓库技能安装与更新跟踪。
- 根与可写性（README「管理范围与安全边界」表，内部规格）：可写——`<项目根>/.dsh/skills`（rank 100）、`<项目根>/.agents/skills`（200）、`~/.dsh/skills`（400）、`~/.agents/skills`（500）；只读——`customSkillDirs`（300）、内置技能目录 bundled（600）。

## 结构导览

- `src/index.ts`：host half，八个 HTTP 路由（list / file / save / delete / git-scan / git-install / git-check / git-update）；仅接受同源请求（回环 Host 校验 + `sec-fetch-site` 同源校验），请求体上限 2 MiB（README「管理范围与安全边界」节）。
- `src/roots.ts`：四个可写根的归属判定（字面 + realpath 双变体，容忍 home 重定向 / 符号链接 / 大小写差异）。
- `src/scan.ts`：根扫描与校验（被遮蔽 / 无效条目也产出，供面板展示与修复）。
- `src/frontmatter.ts`：已知键行级 round-trip（无 YAML 依赖；读取端兼容引号 / 块标量，写入端新值按 YAML 双引号标量序列化）。
- `src/gitInstall.ts` / `src/gitUpdate.ts` / `src/gitMeta.ts`：Git 仓库技能发现与安装、更新检查与应用、安装元数据索引。
- `src/shared.ts`：双端 wire 类型与常量（`RootInfo` 只传语义 id / 路径 / present，不下发展示文案）；wire 类型集中 `src/shared.ts` 的惯例见[根 docs/architecture.md](../../../docs/architecture.md)「双 half 架构」节。
- `src/client.tsx`：client half 与词典接线（`ctx.locale.register` + `bind`；slot 注册声明 `locale: NS`、组件的 `t` 由框架标准 seat 合成进 props）——机制见[根 docs/i18n.md](../../../docs/i18n.md)「多语言约定」节，本插件 apply 域 `bind` 只服务侧栏入口 label thunk 与 store 的事件时间取词。
- `src/client/locales.ts`：本插件词典（命名空间 `dsh-skills`，zh 键集事实源、en 编译期查全）；`sourceLabelT` / `rootOptionLabel` 按来源 / 根 id 在词典侧取词，未知来源回退原文。
- `src/client/`：全局面板页 `SkillsPanelPage.tsx`（挂 `main` keyed 槽位，页壳 `PanelPage` 承载标题与说明，`Panel` 仅作内容列的纵向间距容器）、侧栏入口图标 `SkillsPanelIcon.tsx`（挂 `sidebar.panellist`，点击由侧栏外壳调 `layout.selectPanel` 打开）——技能为可展开卡片，点击行即可行内新建 / 编辑 / 查看（SkillForm / SkillView），Git 安装为弹窗；HTTP 封装自定义头 `x-dsh-skills`。

## 扫描与校验

- 读侧以直接扫描为主数据源；全局 `ctx.skills` 注册表默认为空，仅作只读补充（`ctx.get('skills')` 可选访问，不可用时降级）——选直接扫描的理由见 [decisions.md](decisions.md)。
- 面板每次列表请求都是实时扫描，无缓存。
- 校验与官方 skill-filesystem parser 对齐：`name` / `description` 必填，`whenToUse` 可选；`disable-model-invocation: true` 使技能不进模型目录、`user-invocable: false` 使技能不进用户命令目录，两键缺省即允许（README「使用」节，内部规格）。
- 无效条目判定：缺描述、名称不合法、含旧版调用策略键；与被遮蔽条目一样照常产出，供面板展示与修复。
- 扫描范围边界：preset 通过 `customSkillDirs` 挂载的私有技能目录不在扫描范围，只在其恰好注册进全局注册表时才出现（README「已知限制」节）。

## frontmatter round-trip

- 保存做行级已知键替换：只重写已知键行，未知 frontmatter 字段（如 `license`、`metadata:` 块）、注释与空行原样保留在原位（约束见 AGENTS.md「实现约束」节，新增可编辑键的防错见 [traps.md](traps.md)）。

## Git 安装与更新链路

- 扫描（git-scan）：输入仓库地址扫描其中的技能，支持根 SKILL.md、`skills/`、`.agents/skills/`、`.claude/skills/` 与 `.claude-plugin/marketplace.json` 声明的位置（README「功能」节）。
- 安装（git-install）：勾选后安装到目标根；更新（git-check / git-update）：面板跟踪已安装技能的上游更新，可检查并应用。

## 面板行为语义

- 管理范围固定两档：「全局」只看用户根；「工作区级」= 项目根下 `.dsh/skills` 与 `.agents/skills` + 用户级根，跟随主视图会话 cwd（sessions 快照 `retainedBy.mainView > 0`）；不提供任意目录选择；档位持久化在浏览器本地，默认「全局」。
- 新建：选目标根 + 形态（单文件 `<name>.md` 或目录包 `<name>/SKILL.md`），填名称（kebab-case）、描述、适用时机、两个调用开关与 Markdown 正文；目标根已有同名单文件 / 目录时拒绝，跨根同名是合法的遮蔽用法（如项目级覆盖用户级），不拦截。
- 编辑：表单化编辑五个已知 frontmatter 键 + 正文；无效条目走与正常条目相同的编辑流程，填好 name / description 保存后即成为有效条目。
- 名称锁定不可编辑（与文件名一致）：改名或单文件 ↔ 目录包互转 = 删除后新建；更深的嵌套路径不是官方可发现的技能实体，拒绝删除（理由见 [decisions.md](decisions.md)）。
- 删除：单文件直接删文件；目录包删除整个技能目录（含资源）；删除前弹确认框写明将删除的路径。
- 写入生效时机：新增 / 删除技能、或修改 `name` / `description` 后，正在运行的会话在下一个模型 step 自动收到新目录（无须重启或刷新会话；watcher 有约 200ms 稳定窗口）；改正文不重发目录，模型下次调用 `skill` 工具时读到的就是新正文——易错点见 [traps.md](traps.md)。
- 一次性操作通知走 store `notices` 通道，5 秒 Toast、下次操作即替换，不需跨语言存活；由宿主壳层 `shell.overlay` 槽位的常驻显示点（`SkillsNoticesToast`）订阅显示——触发面（面板 / 弹窗）关闭前后完成的反馈都能播完；组合错误同样在事件时间用当前语言定格——通知套件机制见[根 docs/panel.md](../../../docs/panel.md)「面板交互约定」节。
- 不可翻译的事实原样展示：Host errMsg、扫描 invalid 原因、Git 扫描 notes / problems。
