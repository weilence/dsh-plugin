# @weilence/dsh-skills

DSH web 插件 —— Skills 管理。设置页新增「Skills 管理」菜单页：直接扫描四个
标准技能根呈现完整技能目录（含被遮蔽与校验失败的条目），并集官方注册表里
的只读来源；对可写根做新建 / 编辑 / 删除，支持从 Git 仓库批量安装技能并跟踪更新。

## 功能

- **目录浏览（直接扫描 + 注册表并集）**：每行展示名称、描述、适用时机（`whenToUse`）、来源、调用策略（模型可调用 / 用户 `/命令` 可调用）、文件路径与形态。**被同名高 rank 来源遮蔽**的条目标「被遮蔽」，**frontmatter 校验失败**的条目标「无效」并给出原因——这两类条目不会出现在 agent 的合并目录里，但正是管理面板需要暴露和修复的对象。
- **管理范围（固定两档）**：「当前工作区 + 用户级」——自动跟随主视图会话的工作目录，列出该项目根下的 `.dsh/skills` 与 `.agents/skills` 加上用户级根；或「用户级（全局）」——只看用户根。不提供任意目录选择。
- **新建**：选目标根 + 形态（单文件 `<name>.md` 或目录包 `<name>/SKILL.md`），填名称（kebab-case）、描述、适用时机、两个调用开关与 Markdown 正文。目标根已有同名单文件 / 目录时拒绝；跨根同名是合法的遮蔽用法（如项目级覆盖用户级），不拦。
- **编辑**：表单化编辑五个已知 frontmatter 键 + 正文。保存做行级已知键替换：未知 frontmatter 字段（如 `license`、`metadata:` 块）、注释与空行原样保留。无效条目走同一编辑流修复（填好 name / description 保存即转正）。
- **删除**：单文件直接删文件；目录包删除整个技能目录（含资源），删除前弹确认框写明将删除的路径。
- **Git 安装与更新**：输入仓库地址扫描其中的技能（支持根 SKILL.md、`skills/`、`.agents/skills/`、`.claude/skills/` 与 `.claude-plugin/marketplace.json` 声明的位置），勾选安装到目标根；面板跟踪已安装技能的上游更新，可检查并应用。
- **宽版弹窗**：进入本分区时自动放宽宿主设置弹窗（官方把面板钉在 800×800 且无尺寸 API），切到其他分区即还原，不影响其余设置页。

## 管理范围与安全边界

| 根                                                   | 来源 rank | 可写 |
| ---------------------------------------------------- | --------- | ---- |
| `<项目根>/.dsh/skills`                               | 100       | ✅   |
| `<项目根>/.agents/skills`                            | 200       | ✅   |
| `customSkillDirs`（组合层配置的自定义目录）          | 300       | 只读 |
| `~/.dsh/skills`（`$DSH_HOME`）                       | 400       | ✅   |
| `~/.agents/skills`（`$DSH_AGENTS_HOME`，跨工具共享） | 500       | ✅   |
| 内置技能目录（`bundled`，随应用安装）                | 600       | 只读 |

HTTP 桥仅接受同源请求（回环 Host 校验 + `sec-fetch-site` 同源校验，请求体上限 2 MiB）。

## 安装

宿主 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 均加入
`@weilence/dsh-skills`。启动时 profile boot 会自动合并包内的 `cordis.patch.yml`。

## 使用

安装重启后打开 Web UI 设置 →「Skills 管理」：

1. 顶部选择管理范围：「用户级（全局技能）」或「当前工作区 + 用户级」
   （默认用户级，档位持久化在浏览器本地）；
2. 「新建技能」选目标根与形态，填写元信息与正文后保存；
3. 行内「编辑」修改元信息 / 正文（无效条目在此修复），「删除」移除技能；
4. 外部（IDE / Git / 其他工具）改动点「刷新」即可重新拉取。

**写入后的生效节奏**：新增 / 删除技能、或修改技能的 `name` / `description` 后，正在运行的会话会在下一个模型 step 自动收到新目录（无须重启或刷新会话；有约 200ms 的文件稳定窗）。修改正文不重播目录，但模型下次调用 `skill` 工具时读到的就是新正文。

frontmatter 语义与官方 skill-filesystem parser 对齐：`name` / `description` 必填；`whenToUse` 可选；`disable-model-invocation: true` 使技能不进入模型目录；`user-invocable: false` 使技能不进入用户命令目录；两键缺省即允许。

## 已知限制

- 目录是本插件自己的扫描视图，与某个具体 agent 会话的最终目录可能有细微出入：preset 通过 `customSkillDirs` 挂载的私有技能目录不在扫描范围，只在其恰好注册进全局注册表时才出现。
- 编辑不改变文件名 / 形态：改名或单文件 ↔ 目录包互转请删除后新建。

## 开发

```bash
pnpm --filter @weilence/dsh-skills build
pnpm --filter @weilence/dsh-skills typecheck
pnpm --filter @weilence/dsh-skills test
```

本地接入运行中的宿主：宿主 `package.json` 以 `link:D:/…/plugins/dsh-skills` 方式加入 `dependencies` 与 `dsh.profile.bundles`，构建后重启宿主。机制与改动约定见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
