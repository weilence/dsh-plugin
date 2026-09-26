# dsh-skills

DSH web 插件 —— Skills 管理。设置页新增「Skills 管理」菜单页：直接扫描四个
标准技能根呈现完整技能目录（含被遮蔽与校验失败的条目），并集官方注册表里
的只读来源；对可写根做新建 / 编辑 / 删除。

## 功能

- **目录浏览（直接扫描 + 注册表并集）**：host half 按官方
  skill-filesystem provider 同一套发现规则直接扫描技能根——每行展示名称、
  描述、适用时机（`whenToUse`）、来源、调用策略（模型可调用 / 用户
  `/命令` 可调用）、文件路径与形态。**被同名高 rank 来源遮蔽**的条目标
  「被遮蔽」，**frontmatter 校验失败**（缺描述、名称不合法、含旧版调用
  策略键等）的条目标「无效」并给出原因——这两类条目不会出现在 agent 的
  合并目录里，但正是管理面板需要暴露和修复的对象。
- **为什么不用 `ctx.skills.snapshot()` 做主数据源**：官方 web/desktop
  组合刻意禁用 host 级 `skill-filesystem`（本地发现归各 agent preset 的
  scoped 层），全局注册表默认是空的。本插件以直接扫描为主，注册表
  （`ctx.get('skills')` 可选访问）里落在四个可写根之外的条目——内置
  `bundled`、自定义 `custom` 目录——作为只读行并入列表。
- **管理范围（固定两档）**：「当前工作区 + 用户级」——自动跟随主视图
  会话的工作目录（sessions 快照里 `retainedBy.mainView > 0` 的会话
  cwd），列出该项目根（最近 `.git` 祖先）下的 `.dsh/skills` 与
  `.agents/skills` 加上用户级根；或「用户级（全局）」——只看用户根。
  切换主会话到别的工作区时面板自动跟随刷新；没有打开的工作区会话时该档
  回落到用户级并提示。**不提供任意目录选择——只管理当前工作区与全局
  技能**。
- **新建**：选目标根 + 形态（单文件 `<name>.md` 或目录包
  `<name>/SKILL.md`，目录包可继续手工放置资源文件），填名称
  （kebab-case）、描述、适用时机、两个调用开关与 Markdown 正文。目标根
  已有同名单文件 / 目录时拒绝（同根同名会直接撞文件）；跨根同名是合法的
  遮蔽用法（如项目级覆盖用户级），不拦。
- **编辑**：表单化编辑五个已知 frontmatter 键
  （`name` / `description` / `whenToUse` / `disable-model-invocation` /
  `user-invocable`）+ 正文。保存做**行级已知键替换**：未知 frontmatter
  字段（如 `license`、`metadata:` 块）、注释与空行原样保留在原位，不会
  因为结构化编辑被静默丢弃。名称编辑时锁定（与文件名保持一致）。无效
  条目走同一编辑流修复（填好 name / description 保存即转正）。
- **删除**：单文件直接删文件；目录包删除整个技能目录（含资源），删除前
  弹确认框写明将删除的路径。更深的嵌套路径不是官方可发现的技能实体，
  拒绝删除以免误伤。
- **查看**：只读来源（内置、自定义目录）也可查看元信息与文件原文；
  无文件的虚拟（运行时）技能不参与列表。

## 管理范围与安全边界

| 根                                                   | 来源 rank | 可写 |
| ---------------------------------------------------- | --------- | ---- |
| `<项目根>/.dsh/skills`                               | 100       | ✅   |
| `<项目根>/.agents/skills`                            | 200       | ✅   |
| `customSkillDirs`（组合层配置的自定义目录）          | 300       | 只读 |
| `~/.dsh/skills`（`$DSH_HOME`）                       | 400       | ✅   |
| `~/.agents/skills`（`$DSH_AGENTS_HOME`，跨工具共享） | 500       | ✅   |
| 内置技能目录（`bundled`，随应用安装）                | 600       | 只读 |

- 编辑 / 删除仅作用于归属上述四个可写根的路径；读取额外放行当前注册表
  快照里出现的只读来源路径。host 侧对根与技能路径做字面 + realpath 双
  变体归属判定（容忍 home 重定向、符号链接、大小写差异等）。
- HTTP 桥仅接受同源请求：loopback Host 校验（防 DNS rebinding，与
  dsh-models 同款）+ 写操作 `sec-fetch-site` 同源校验（dsh-app: 自定义
  协议页面头缺席放行，与 dsh-notify 同款）；请求体上限 2 MiB。
- 本插件是宿主侧受信代码：写文件用 node:fs 直落盘（用户从设置页发起的
  操作，不走模型沙箱策略）。

## 安装

宿主 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 均加入
`dsh-skills`。启动时 profile boot 会自动合并包内的 `cordis.patch.yml`，
把插件行插入 host composition。插件只硬依赖 `webServer`；skill 注册表经
`ctx.get('skills')` 可选访问，组合未挂载时只读来源行缺席，其余功能完整。

## 使用

安装重启后打开 Web UI 设置 →「Skills 管理」：

1. 顶部选择管理范围：「用户级（全局技能）」或「当前工作区 + 用户级」
   （默认用户级，档位持久化在浏览器本地；工作区档自动跟随当前打开的
   会话）；
2. 「新建技能」选目标根与形态，填写元信息与正文后保存；
3. 行内「编辑」修改元信息 / 正文（无效条目在此修复），「删除」移除技能；
4. 外部（IDE / Git / 其他工具）改动点「刷新」即可重新拉取——每次列表
   请求都是实时扫描，无缓存。

frontmatter 语义与官方 skill-filesystem parser 对齐：`name` /
`description` 必填；`whenToUse` 可选；`disable-model-invocation: true`
使技能不进入模型目录；`user-invocable: false` 使技能不进入用户命令目录；
两键缺省即允许，因此开关保持开启时不会写入对应键。

## 写入后的自动重载与会话播报

**触发重播的条件：新增技能、删除技能、修改技能的 `name` 或
`description`**（面板保存或 IDE / Git 等外部改动均可）。此时不需要重启
宿主、不需要刷新会话，正在运行的会话会在下一个模型 step 自动收到新
目录。**修改正文（body）不触发重播**——目录对正在运行的会话不变，但
模型下次调用 `skill` 工具时读到的就是新正文。完整链路：

```
技能文件落盘（插件写入 / IDE / Git）
  → chokidar watcher（preset 层 skill-filesystem 持有，~200ms 稳定窗）
  → provider.invalidate()
  → 注册表 revision 递增，目录缓存作废
  → 下一次 snapshot() 重新扫描
  → 会话的下一个 agent/pre-step：digest 新目录，与上一条可见目录消息比对
  → 摘要变化 → agent.inject() 追加一条完整替换目录（durable，进会话历史）
```

三个值得知道的细节：

1. **目录只携带 `name` + `description`**（默认 500 字符截断）。所以修改
   正文不改变目录摘要、不产生新的目录消息；`skill` 工具的加载是每次按需
   重读文件，正文的修改在下一次工具调用时立即生效。
2. **有 ~200ms 的 watcher 稳定窗**。chokidar 要求文件稳定后才上报，保存
   后立即开始的那个 step 可能还拿到旧目录，下一个 step 一定拿到新的——
   保存时模型刚好在跑的话，等它这一步结束即可。
3. **压缩不会弄丢目录**。即使历史目录消息全部被 compaction 隐藏，下一个
   完整快照会重新建立当前目录；删光技能也会追加一条显式的空目录。

验证方法：在会话里让模型列出它可见的 skills，然后在面板新增一个技能，
再问一次——下一步的回复里就会出现新技能的名字。

## 工作原理

```
client half (src/client.tsx + src/client/*)
  settings.section → 设置页「Skills 管理」
  GET  /dsh-skills/list?cwd=…      → 根 + 技能目录（含可编辑性/遮蔽/无效）
  GET  /dsh-skills/file?path=…     → 技能文件原文（编辑 / 查看）
  POST /dsh-skills/save            → 新建 / 编辑（行级 frontmatter 往返）
  POST /dsh-skills/delete          → 删除单文件 / 目录包

host half (src/index.ts)
  scan.ts                          → 四个标准技能根的直接扫描（官方发现
                                      与校验规则；invalid 行可修复）
  ctx.get('skills')?.snapshot()    → 只读来源补充并集（可选）
  node:fs                          → 技能文件的直接读写
  shared.ts / frontmatter.ts       → 双端共享 wire 类型与纯函数
```

frontmatter 往返（`src/frontmatter.ts`）不引入 YAML 依赖：读取端兼容
引号标量与块标量（`>` / `|`）；写入端只重写已知键行、原样保留其余行，
新值需要引号时按 YAML 双引号标量序列化。

## 已知限制

- 目录是本插件自己的扫描视图，与某个具体 agent 会话的最终目录可能有
  细微出入：preset 通过 `customSkillDirs` 挂载的私有技能目录（如官方
  preset 的创造模式技能）不在本面板的扫描范围，只在其恰好注册进全局
  注册表时才出现。
- 编辑不改变文件名 / 形态：改名或单文件 ↔ 目录包互转请删除后新建。
- 写入后会话目录的刷新节奏（watcher 稳定窗、正文修改不重播目录等）
  见上文「写入后的自动重载与会话播报」。

## 开发

```bash
pnpm install        # 安装依赖
pnpm build          # 构建产物到 lib/（tsdown，双 half）
pnpm watch          # 监听式构建
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest 单测
```

宿主契约类型全部取自官方 npm 包的 **type-only 导入**（声明合并进
`@deepseek-ai/cordis` 的 `Context` 接口），编译产物保持零运行时导入。
来源与版本（对齐运行宿主 0.1.7-rc.2，npm dist-tag `next`）：

| 契约                                  | 官方包                                           |
| ------------------------------------- | ------------------------------------------------ |
| `Context` / `effect`                  | `@deepseek-ai/cordis`                            |
| `ctx.skills` / `SkillCatalogSnapshot` | `@deepseek-ai/dsh-skill`                         |
| `ctx.webServer` / 路由注册            | `@deepseek-ai/dsh-host-webserver`                |
| `dshHomePath`                         | `@deepseek-ai/dsh-home-paths`（peer）            |
| `ctx.slots`（client）                 | `@deepseek-ai/dsh-client-ui-renderer/client`     |
| `settings.section` 槽位契约（client） | `@deepseek-ai/dsh-client-ui-settings/client`     |
| `ctx.sessions`（client）              | `@deepseek-ai/dsh-api-session-controller/client` |

本地接入运行中的宿主（desktop profile）：宿主 `package.json` 以
`link:D:/…/plugins/dsh-skills`（或 `file:`）方式加入 `dependencies` 与
`dsh.profile.bundles`，`pnpm build` 后重启宿主即可。`link:`（junction）
配合在 profile 用户补丁层的 `hmr` 行 `root` 里加
`…/plugins/dsh-skills/lib`，可获得与其余三个插件一致的 watch 热载入开发
循环；注意 host half 的模块经 Node ESM 缓存按 URL 命中——运行中在
`file:` ↔ `link:` 之间切换或重装后需要重启宿主才会重新加载。

## 许可证

MIT
